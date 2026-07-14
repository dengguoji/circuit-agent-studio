from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from persistence import ConversationStore, RevisionConflictError


class ConversationStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = ConversationStore(root / "state.sqlite3", root / "assets")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_conversation_canvas_revision_and_crud(self) -> None:
        conversation = self.store.create_conversation(
            title="RC circuit", provider="bailian", model="qwen-test"
        )
        self.assertEqual(conversation["canvas_revision"], 0)
        updated = self.store.put_canvas(
            conversation["id"], {"components": [{"id": "cmp_1"}]}, expected_revision=0
        )
        self.assertEqual(updated["canvas_revision"], 1)
        with self.assertRaises(RevisionConflictError):
            self.store.put_canvas(conversation["id"], {}, expected_revision=0)

        patched = self.store.update_conversation(
            conversation["id"], {"title": "Updated", "reasoning_mode": "deep"}
        )
        self.assertEqual(patched["title"], "Updated")
        self.assertEqual(patched["reasoning_mode"], "deep")
        self.assertEqual(patched["canvas_state"]["components"][0]["id"], "cmp_1")
        self.assertEqual(len(self.store.list_conversations()), 1)

    def test_events_never_persist_inline_base64(self) -> None:
        conversation = self.store.create_conversation(model="qwen-test")
        event = self.store.append_event(
            conversation["id"],
            "user.message",
            {"role": "user", "content": "data:image/png;base64,AAAA"},
        )
        self.assertEqual(event["data"]["content"], "[omitted:data-url]")
        loaded = self.store.list_events(conversation["id"])[0]
        self.assertNotIn("base64,AAAA", str(loaded))

    def test_turn_cancel_is_idempotent(self) -> None:
        conversation = self.store.create_conversation(model="qwen-test")
        turn = self.store.create_turn(
            conversation["id"], provider="bailian", model="qwen-test", clear_allowed=False
        )
        stopped = self.store.cancel_turn(turn["turn_id"])
        stopped_again = self.store.cancel_turn(turn["turn_id"])
        self.assertEqual(stopped["status"], "stopped")
        self.assertEqual(stopped_again["status"], "stopped")
        self.assertEqual(stopped_again["stop_reason"], "user_stopped")

    def test_asset_is_content_addressed_per_conversation(self) -> None:
        conversation = self.store.create_conversation(model="qwen-test")
        first = self.store.save_asset(
            b"fake-image", filename="diagram.png", mime_type="image/png", conversation_id=conversation["id"]
        )
        second = self.store.save_asset(
            b"fake-image", filename="other.png", mime_type="image/png", conversation_id=conversation["id"]
        )
        self.assertEqual(first["id"], second["id"])
        internal = self.store.get_asset(first["id"], include_storage_path=True)
        self.assertTrue(Path(internal["storage_path"]).exists())


if __name__ == "__main__":
    unittest.main()
