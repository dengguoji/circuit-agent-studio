from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from context_observer import ContextHistoryRecorder


class ContextHistoryRecorderTests(unittest.TestCase):
    def test_writes_complete_unabridged_context_and_provider_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            recorder = ContextHistoryRecorder(temporary)
            large_tool_result = "catalog:" + "x" * 20_000
            inline_image = "data:image/png;base64," + "A" * 8_192
            reference = recorder.start_step(
                "conv_test",
                "turn_test",
                {
                    "messages": [
                        {"role": "tool", "content": large_tool_result},
                        {"role": "user", "content": inline_image},
                    ],
                    "tools": [{"type": "function", "function": {"name": "inspect_canvas"}}],
                },
            )
            recorder.append_provider_event(
                reference,
                {
                    "type": "provider.request",
                    "request": {"messages": [{"content": large_tool_result}]},
                },
            )
            recorder.append_provider_event(
                reference,
                {
                    "type": "provider.response",
                    "response": {"output_text": "complete response"},
                },
            )
            recorder.complete_step(reference, result={"assistant_message": {"content": "done"}})

            document_path = recorder.document_path("conv_test", "turn_test")
            document = json.loads(document_path.read_text(encoding="utf-8"))
            step = document["steps"][0]
            self.assertTrue(document["complete"])
            self.assertEqual(step["logical_context"]["messages"][0]["content"], large_tool_result)
            self.assertEqual(step["logical_context"]["messages"][1]["content"], inline_image)
            self.assertEqual(step["provider_events"][0]["request"]["messages"][0]["content"], large_tool_result)
            self.assertEqual(step["provider_events"][1]["response"]["output_text"], "complete response")
            self.assertIsNone(step["terminal_error"])

            index = json.loads((Path(temporary) / "index.json").read_text(encoding="utf-8"))
            self.assertTrue(index["no_truncation"])
            self.assertEqual(index["latest"]["path"], "conv_test/turn_test.json")

    def test_records_terminal_errors_without_losing_the_request(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            recorder = ContextHistoryRecorder(temporary)
            reference = recorder.start_step("conv", "turn", {"messages": [{"content": "full"}]})
            recorder.append_provider_event(reference, {"type": "provider.request", "request": {"input": "full"}})
            recorder.complete_step(reference, error=RuntimeError("provider failed"))

            document = json.loads(recorder.document_path("conv", "turn").read_text(encoding="utf-8"))
            step = document["steps"][0]
            self.assertEqual(step["provider_events"][0]["request"]["input"], "full")
            self.assertEqual(step["terminal_error"]["type"], "RuntimeError")
            self.assertEqual(step["terminal_error"]["message"], "provider failed")


if __name__ == "__main__":
    unittest.main()
