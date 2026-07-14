from __future__ import annotations

import os
import tempfile
import threading
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.request import Request, urlopen

import server


def model_result(*, tool: bool = True, response_id: str = "resp_1") -> dict:
    tool_calls = []
    if tool:
        tool_calls = [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "inspect_canvas", "arguments": "{}"},
            }
        ]
    message = {"role": "assistant", "content": "done" if not tool else None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "protocol": "responses",
        "response_id": response_id,
        "assistant_message": message,
        "tool_calls": tool_calls,
        "usage": {
            "input_tokens": 10,
            "output_tokens": 2,
            "total_tokens": 12,
            "cached_tokens": 0,
            "reasoning_tokens": 1,
            "image_tokens": 0,
            "context_window": None,
            "context_ratio": None,
        },
        "reasoning_summary": "checked",
    }


class ServerContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.environment = patch.dict(
            os.environ,
            {
                "CIRCUIT_DATABASE_PATH": str(root / "state.sqlite3"),
                "CIRCUIT_ASSET_DIR": str(root / "assets"),
                "CIRCUIT_CONTEXT_HISTORY_ENABLED": "true",
                "CIRCUIT_CONTEXT_HISTORY_DIR": str(root / "context_history"),
            },
        )
        self.environment.start()
        server._STORE = None
        server._STORE_KEY = ""
        server._CONTEXT_RECORDER = None
        server._CONTEXT_RECORDER_KEY = ""
        server._ACTIVE_PROVIDER_CLIENTS.clear()

    def tearDown(self) -> None:
        server._ACTIVE_PROVIDER_CLIENTS.clear()
        server._STORE = None
        server._STORE_KEY = ""
        server._CONTEXT_RECORDER = None
        server._CONTEXT_RECORDER_KEY = ""
        self.environment.stop()
        self.temporary.cleanup()

    def test_coordinate_schemas_are_distinct(self) -> None:
        self.assertEqual(server.COMPONENT_POINT_SCHEMA["items"]["multipleOf"], 10)
        self.assertEqual(server.CONNECTION_POINT_SCHEMA["items"]["multipleOf"], 5)
        draw_wire = next(
            tool for tool in server.TOOLS if tool["function"]["name"] == "draw_wire_segment"
        )
        self.assertEqual(
            draw_wire["function"]["parameters"]["properties"]["start"]["items"]["multipleOf"], 5
        )

    def test_context_history_can_be_disabled(self) -> None:
        with patch.dict(os.environ, {"CIRCUIT_CONTEXT_HISTORY_ENABLED": "false"}):
            self.assertIsNone(server.get_context_recorder())

    def test_markdown_prompt_asset_and_conditional_image_rules(self) -> None:
        self.assertEqual(server.PROMPT_ASSET.metadata["version"], "2.2.0")
        self.assertIn("# 角色", server.SYSTEM_PROMPT)
        self.assertNotIn("OpenAI tool_calls", server.SYSTEM_PROMPT)

        text_prompt = server.make_user_content(
            "把 R1 向右移动",
            {"components": [{"id": "cmp_1"}]},
            {"width": 1280, "height": 720},
        )
        self.assertIn("# 用户请求\n\n把 R1 向右移动", text_prompt)
        self.assertIn("# 当前画布", text_prompt)
        self.assertNotIn("# 图片还原", text_prompt)
        self.assertNotIn("{{", text_prompt)

        image_prompt = server.make_user_content(
            "按图绘制",
            {},
            {"width": 1280, "height": 720},
            {"name": "reference.png", "mime_type": "image/png", "width": 800, "height": 600},
        )
        self.assertIn("# 图片还原", image_prompt)
        self.assertIn("reference.png", image_prompt)

    def test_clear_tool_requires_explicit_non_negated_wording(self) -> None:
        self.assertTrue(server.is_explicit_clear_request("清空画布，然后重新画"))
        self.assertTrue(server.is_explicit_clear_request("redraw from scratch"))
        self.assertFalse(server.is_explicit_clear_request("把 R1 移到右边并重新连接"))
        self.assertFalse(server.is_explicit_clear_request("不要清空画布，只做修改"))
        edit_tools = server.tools_for_request(False)
        self.assertNotIn("clear_canvas", [item["function"]["name"] for item in edit_tools])
        with self.assertRaises(ValueError):
            server.enforce_tool_policy(
                [{"function": {"name": "clear_canvas", "arguments": "{}"}}], False
            )

    def test_legacy_debug_snapshots_are_scrubbed_atomically(self) -> None:
        root = Path(self.temporary.name) / "debug"
        root.mkdir()
        snapshot = root / "messages归档.json"
        snapshot.write_text(
            server.json.dumps(
                {"messages": [{"image": "data:image/png;base64,AAAA"}]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        self.assertEqual(server.scrub_legacy_debug_snapshots(str(root)), 1)
        self.assertNotIn("base64", snapshot.read_text(encoding="utf-8"))
        self.assertEqual(server.scrub_legacy_debug_snapshots(str(root)), 0)

    def test_response_chain_rebuild_keeps_current_image_but_drops_old_tool_protocol(self) -> None:
        current_content = [
            {"type": "text", "text": "current"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ]
        rebuilt = server._responses_rebuild_messages([
            {"role": "system", "content": "system"},
            {"role": "user", "content": "old request"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{"id": "old", "function": {"name": "inspect_canvas", "arguments": "{}"}}],
            },
            {"role": "tool", "tool_call_id": "old", "content": "ok"},
            {"role": "user", "content": current_content},
        ])
        self.assertFalse(any("tool_calls" in message for message in rebuilt))
        self.assertEqual(rebuilt[-1]["content"], current_content)

    def test_compact_summary_covers_only_turns_older_than_recent_six(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        store = server.get_store()
        for index in range(8):
            store.append_event(
                conversation["id"],
                "user.message",
                {"role": "user", "content": server.json.dumps({"user_request": f"request {index}"})},
                role="user",
            )
            store.append_event(
                conversation["id"],
                "assistant.message",
                {"role": "assistant", "content": f"answer {index}"},
                role="assistant",
            )
        summary = server.refresh_conversation_summary(conversation["id"])
        self.assertIn("request 0", summary)
        self.assertIn("request 1", summary)
        self.assertNotIn("request 2", summary)
        prompt = server.system_prompt_for_conversation(store.get_conversation(conversation["id"]))
        self.assertIn("紧凑摘要", prompt)

    def test_legacy_agent_filters_clear_tool_and_keeps_response_contract(self) -> None:
        captured = {}

        def invoke(state, config):
            captured.update(state)
            return model_result()

        with patch.object(server.AGENT_GRAPH, "invoke", side_effect=invoke):
            response = server.call_agent({
                "message": "把 R1 向右移动",
                "model_provider": "bailian",
                "model": "qwen3.7-plus",
                "canvas_state": {},
            })
        names = [tool["function"]["name"] for tool in captured["tools"]]
        self.assertNotIn("clear_canvas", names)
        self.assertFalse(response["clear_allowed"])
        self.assertIn("usage", response)
        self.assertIn("protocol", response)

    def test_conversation_turn_contract_and_persistence(self) -> None:
        conversation = server.create_conversation(
            {"title": "Demo", "model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        with patch.object(server, "_invoke_provider", return_value=model_result()):
            response = server.start_conversation_turn(
                conversation["id"],
                {"message": "把 R1 移到右边", "canvas_state": {"components": []}},
            )
        required = {
            "turn_id", "status", "provider", "model", "protocol", "assistant_message",
            "tool_calls", "messages", "usage", "reasoning_summary", "clear_allowed",
        }
        self.assertTrue(required.issubset(response))
        self.assertEqual(response["status"], "requires_action")
        self.assertFalse(response["clear_allowed"])
        self.assertEqual(response["protocol"], "responses")
        persisted = server.get_store().get_conversation(conversation["id"])
        self.assertEqual(persisted["previous_response_id"], "resp_1")

        with patch.object(server, "_invoke_provider", return_value=model_result(tool=False, response_id="resp_2")):
            completed = server.continue_turn(
                response["turn_id"],
                {
                    "tool_outputs": [{"tool_call_id": "call_1", "content": {"ok": True}}],
                    "canvas_state": {"components": [{"id": "cmp_1"}]},
                    "canvas_revision": 0,
                    "require_tool": False,
                },
            )
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["usage"]["total_tokens"], 24)
        self.assertEqual(completed["canvas_revision"], 1)
        self.assertEqual(server.get_store().get_conversation(conversation["id"])["canvas_revision"], 1)

    def test_stop_is_idempotent_and_late_result_guard_is_in_store(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        turn = server.get_store().create_turn(
            conversation["id"], provider="bailian", model="qwen3.7-plus", clear_allowed=False
        )
        first = server.cancel_turn(turn["turn_id"])
        second = server.cancel_turn(turn["turn_id"])
        self.assertEqual(first["status"], "stopped")
        self.assertEqual(second["status"], "stopped")
        stopped_events = [event for event in second["events"] if event["type"] == "turn.stopped"]
        self.assertEqual(len(stopped_events), 1)

    def test_cancel_closes_the_active_provider_client(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        turn = server.get_store().create_turn(
            conversation["id"], provider="bailian", model="qwen3.7-plus", clear_allowed=False
        )
        client = Mock()
        server._ACTIVE_PROVIDER_CLIENTS[turn["turn_id"]] = client
        cancelled = server.cancel_turn(turn["turn_id"])
        self.assertEqual(cancelled["status"], "stopped")
        client.close.assert_called_once_with()
        self.assertNotIn(turn["turn_id"], server._ACTIVE_PROVIDER_CLIENTS)

    def test_client_turn_id_can_cancel_during_initial_model_request(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        client_turn_id = "turn_client_generated_123"

        def cancel_before_return(**kwargs):
            server.cancel_turn(client_turn_id)
            return model_result()

        with patch.object(server, "_invoke_provider", side_effect=cancel_before_return):
            response = server.start_conversation_turn(
                conversation["id"],
                {"turn_id": client_turn_id, "message": "绘制一个 RC 电路"},
            )
        self.assertEqual(response["turn_id"], client_turn_id)
        self.assertEqual(response["status"], "stopped")
        self.assertEqual(response["assistant_message"], None)
        self.assertFalse(any(event["type"] == "assistant.message" for event in response["events"]))
        self.assertEqual(server.cancel_turn(client_turn_id)["status"], "stopped")

    def test_turn_endpoint_streams_unified_sse_events_and_final_envelope(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.CircuitAgentHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                f"http://127.0.0.1:{httpd.server_port}/api/conversations/{conversation['id']}/turns",
                data=server.json.dumps({
                    "turn_id": "turn_stream_test",
                    "message": "检查画布",
                }).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                },
                method="POST",
            )
            with patch.object(server, "_invoke_provider", return_value=model_result()), urlopen(
                request, timeout=5
            ) as response:
                body = response.read().decode("utf-8")
            self.assertIn("event: turn.started", body)
            self.assertIn("event: reasoning.summary.delta", body)
            self.assertIn("event: step.completed", body)
            self.assertIn('"turn_id":"turn_stream_test"', body)
            self.assertIn('"status":"requires_action"', body)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def test_doubao_file_upload_polls_until_active_and_reuses_file_id(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "doubao", "model": "doubao-2.0-pro-250515"}
        )
        asset = server.get_store().save_asset(
            b"same-image",
            filename="circuit.png",
            mime_type="image/png",
            conversation_id=conversation["id"],
        )
        files = SimpleNamespace(
            create=Mock(return_value=SimpleNamespace(id="file_1", status="processing")),
            retrieve=Mock(
                side_effect=[
                    SimpleNamespace(id="file_1", status="processing"),
                    SimpleNamespace(id="file_1", status="active"),
                ]
            ),
        )
        with (
            patch.object(server, "build_client", return_value=SimpleNamespace(files=files)),
            patch.dict(os.environ, {"CIRCUIT_FILE_POLL_ATTEMPTS": "3", "CIRCUIT_FILE_POLL_INTERVAL": "0"}),
        ):
            uploaded = server.upload_asset_to_provider(asset["id"], "doubao")
        self.assertEqual(uploaded["provider_file_id"], "file_1")
        self.assertEqual(uploaded["status"], "active")
        self.assertEqual(files.create.call_count, 1)
        self.assertEqual(files.retrieve.call_count, 2)

        with patch.object(server, "build_client") as build_client:
            reused = server.upload_asset_to_provider(asset["id"], "doubao")
        self.assertEqual(reused["provider_file_id"], "file_1")
        build_client.assert_not_called()

    def test_bailian_temporary_oss_upload_is_model_bound_and_reused(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        asset = server.get_store().save_asset(
            b"temporary-image",
            filename="circuit.png",
            mime_type="image/png",
            conversation_id=conversation["id"],
        )
        policy = {
            "data": {
                "upload_host": "https://example-oss.aliyuncs.com",
                "upload_dir": "dashscope-instant/test",
                "oss_access_key_id": "temporary-access",
                "signature": "temporary-signature",
                "policy": "temporary-policy",
                "x_oss_object_acl": "private",
                "x_oss_forbid_overwrite": "true",
            }
        }
        requests = []

        class FakeResponse(BytesIO):
            def __init__(self, data: bytes = b"", status: int = 200):
                super().__init__(data)
                self.status = status

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def fake_urlopen(request, timeout):
            requests.append((request, timeout))
            if request.get_method() == "GET":
                return FakeResponse(server.json.dumps(policy).encode("utf-8"))
            self.assertIn(b"temporary-image", request.data)
            self.assertIn(b'dashscope-instant/test/circuit.png', request.data)
            return FakeResponse(status=200)

        with (
            patch.object(server, "urlopen", side_effect=fake_urlopen),
            patch.dict(os.environ, {"BAILIAN_API_KEY": "test-key"}),
        ):
            uploaded = server.upload_asset_to_provider(
                asset["id"], "bailian", "qwen3.7-plus"
            )
        self.assertEqual(uploaded["provider"], "bailian")
        self.assertEqual(uploaded["provider_model"], "qwen3.7-plus")
        self.assertEqual(
            uploaded["provider_file_id"], "oss://dashscope-instant/test/circuit.png"
        )
        self.assertEqual(uploaded["status"], "active")
        self.assertEqual(len(requests), 2)

        with patch.object(server, "urlopen") as urlopen:
            reused = server.upload_asset_to_provider(
                asset["id"], "bailian", "qwen3.7-plus"
            )
        self.assertEqual(reused["provider_file_id"], uploaded["provider_file_id"])
        urlopen.assert_not_called()

    def test_visual_review_inputs_use_provider_native_references(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "doubao", "model": "doubao-2.0-pro-250515"}
        )
        asset = server.get_store().save_asset(
            b"visual-review", filename="review.png", mime_type="image/png",
            conversation_id=conversation["id"],
        )
        server.get_store().update_asset_provider(
            asset["id"],
            provider="doubao",
            provider_model="doubao-2.0-pro-250515",
            provider_file_id="file_review",
            status="active",
        )
        response_item, chat_message = server.build_visual_review_input(
            conversation["id"], "doubao", "doubao-2.0-pro-250515", "responses", [asset["id"]]
        )
        self.assertIsNone(chat_message)
        self.assertEqual(response_item["content"][-1], {"type": "input_image", "file_id": "file_review"})

        expires_at = (server.datetime.now(server.timezone.utc) + server.timedelta(hours=47)).isoformat()
        server.get_store().update_asset_provider(
            asset["id"],
            provider="bailian",
            provider_model="qwen3.7-plus",
            provider_file_id="oss://dashscope-instant/review.png",
            status="active",
            expires_at=expires_at,
        )
        response_item, chat_message = server.build_visual_review_input(
            conversation["id"], "bailian", "qwen3.7-plus", "chat_completions", [asset["id"]]
        )
        self.assertEqual(response_item["content"][-1]["image_url"], "oss://dashscope-instant/review.png")
        self.assertEqual(chat_message["content"][-1]["image_url"]["url"], "oss://dashscope-instant/review.png")

    def test_local_asset_is_inlined_once_but_not_returned_or_persisted_as_base64(self) -> None:
        conversation = server.create_conversation(
            {"model_provider": "bailian", "model": "qwen3.7-plus"}
        )
        asset = server.get_store().save_asset(
            b"reference-image",
            filename="reference.png",
            mime_type="image/png",
            conversation_id=conversation["id"],
        )
        captured = {}

        def invoke(**kwargs):
            captured.update(kwargs)
            return model_result(tool=False)

        with patch.object(server, "_invoke_provider", side_effect=invoke):
            response = server.start_conversation_turn(
                conversation["id"],
                {"message": "按图绘制", "asset_id": asset["id"], "require_tool": False},
            )
        self.assertIn("data:image/png;base64,", str(captured["messages"]))
        self.assertNotIn("data:image/png;base64,", str(response))
        persisted = server.get_store().list_events(conversation["id"])
        self.assertNotIn("data:image/png;base64,", str(persisted))


if __name__ == "__main__":
    unittest.main()
