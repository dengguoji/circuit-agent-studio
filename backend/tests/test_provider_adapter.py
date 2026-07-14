from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from provider_adapter import (
    ProviderAdapter,
    adapt_openai_responses_request,
    build_openai_responses_request,
    normalize_usage,
)


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "inspect_canvas",
            "description": "Inspect",
            "parameters": {"type": "object", "properties": {}},
        },
    }
]


class ProviderAdapterTests(unittest.TestCase):
    def test_usage_normalizes_chat_and_reasoning_details(self) -> None:
        usage = normalize_usage(
            {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_tokens_details": {"cached_tokens": 40},
                "completion_tokens_details": {"reasoning_tokens": 5},
            },
            1000,
        )
        self.assertEqual(usage["input_tokens"], 100)
        self.assertEqual(usage["cached_tokens"], 40)
        self.assertEqual(usage["reasoning_tokens"], 5)
        self.assertEqual(usage["context_ratio"], 0.1)

    def test_openai_request_is_canonical_before_provider_adaptation(self) -> None:
        canonical = build_openai_responses_request(
            model="gpt-test",
            instructions="system",
            input_items=[{"role": "user", "content": "draw"}],
            tools=TOOLS,
            require_tool=True,
            reasoning_mode="deep",
            previous_response_id="resp_previous",
        )
        self.assertEqual(canonical["reasoning"], {"effort": "high", "summary": "auto"})
        self.assertEqual(canonical["previous_response_id"], "resp_previous")
        self.assertTrue(canonical["store"])

        openai_request, openai_omitted = adapt_openai_responses_request("openai", canonical)
        self.assertEqual(openai_request, canonical)
        self.assertEqual(openai_omitted, [])

        for provider_id in ("bailian", "doubao"):
            with self.subTest(provider_id=provider_id):
                provider_request, omitted = adapt_openai_responses_request(provider_id, canonical)
                self.assertEqual(provider_request["reasoning"], {"effort": "high"})
                self.assertEqual(omitted, ["reasoning.summary"])
                self.assertEqual(canonical["reasoning"], {"effort": "high", "summary": "auto"})

    def test_responses_is_preferred_and_normalized(self) -> None:
        response = {
            "id": "resp_1",
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Check topology"}]},
                {"type": "function_call", "call_id": "call_1", "name": "inspect_canvas", "arguments": "{}"},
            ],
            "usage": {"input_tokens": 12, "output_tokens": 4, "total_tokens": 16},
        }
        client = SimpleNamespace(
            responses=SimpleNamespace(create=Mock(return_value=response)),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        result = ProviderAdapter().invoke(
            client=client,
            provider_id="bailian",
            model="qwen-test",
            messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "draw"}],
            tools=TOOLS,
            require_tool=True,
        )
        self.assertEqual(result["protocol"], "responses")
        self.assertEqual(result["tool_calls"][0]["id"], "call_1")
        self.assertEqual(result["reasoning_summary"], "Check topology")
        request = client.responses.create.call_args.kwargs
        self.assertEqual(request["reasoning"], {"effort": "medium"})
        self.assertNotIn("summary", request["reasoning"])
        client.chat.completions.create.assert_not_called()

    def test_bailian_and_doubao_use_the_same_openai_flow_with_wire_compatibility(self) -> None:
        response = {
            "id": "resp_provider",
            "output": [
                {"type": "function_call", "call_id": "call_provider", "name": "inspect_canvas", "arguments": "{}"}
            ],
            "usage": {"input_tokens": 8, "output_tokens": 2, "total_tokens": 10},
        }
        for provider_id in ("bailian", "doubao"):
            with self.subTest(provider_id=provider_id):
                create = Mock(return_value=response)
                client = SimpleNamespace(
                    responses=SimpleNamespace(create=create),
                    chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
                )
                result = ProviderAdapter().invoke(
                    client=client,
                    provider_id=provider_id,
                    model=f"{provider_id}-test",
                    messages=[
                        {"role": "system", "content": "system"},
                        {"role": "user", "content": "draw"},
                    ],
                    tools=TOOLS,
                    require_tool=True,
                )
                self.assertEqual(result["protocol"], "responses")
                self.assertEqual(create.call_args.kwargs["reasoning"], {"effort": "medium"})
                self.assertTrue(create.call_args.kwargs["store"])
                client.chat.completions.create.assert_not_called()

    def test_initial_responses_failure_does_not_fall_back_by_default(self) -> None:
        observed = []
        client = SimpleNamespace(
            responses=SimpleNamespace(create=Mock(side_effect=RuntimeError("provider unavailable"))),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
            ProviderAdapter().invoke(
                client=client,
                provider_id="doubao",
                model="doubao-test",
                messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "draw"}],
                tools=TOOLS,
                require_tool=True,
                observer=observed.append,
            )
        self.assertEqual(
            [event["type"] for event in observed],
            ["provider.compatibility", "provider.request", "provider.error"],
        )
        client.chat.completions.create.assert_not_called()

    def test_optional_parameter_error_never_triggers_chat_fallback(self) -> None:
        client = SimpleNamespace(
            responses=SimpleNamespace(
                create=Mock(side_effect=RuntimeError('InvalidParameter: json: unknown field "summary"'))
            ),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        with self.assertRaisesRegex(RuntimeError, "unknown field"):
            ProviderAdapter().invoke(
                client=client,
                provider_id="doubao",
                model="doubao-test",
                messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "draw"}],
                tools=TOOLS,
                require_tool=True,
                allow_chat_fallback=True,
            )
        client.chat.completions.create.assert_not_called()

    def test_explicit_fallback_only_for_unavailable_responses_endpoint(self) -> None:
        observed = []
        tool_call = SimpleNamespace(
            id="call_2",
            type="function",
            function=SimpleNamespace(name="inspect_canvas", arguments="{}"),
        )
        completion = SimpleNamespace(
            id="chat_1",
            choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=[tool_call]))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12),
        )
        client = SimpleNamespace(
            responses=SimpleNamespace(
                create=Mock(side_effect=RuntimeError("404 Not Found: Responses endpoint is not supported"))
            ),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock(return_value=completion))),
        )
        result = ProviderAdapter().invoke(
            client=client,
            provider_id="doubao",
            model="doubao-test",
            messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "draw"}],
            tools=TOOLS,
            require_tool=True,
            allow_chat_fallback=True,
            observer=observed.append,
        )
        self.assertEqual(result["protocol"], "chat_completions")
        self.assertEqual(result["tool_calls"][0]["id"], "call_2")
        self.assertEqual(
            [event["type"] for event in observed],
            [
                "provider.compatibility",
                "provider.request",
                "provider.error",
                "protocol.fallback",
                "provider.request",
                "provider.response",
            ],
        )
        self.assertEqual(observed[1]["request"]["input"][0]["content"], "draw")
        self.assertIn("Responses endpoint", observed[3]["error"]["message"])

    def test_chat_does_not_expose_raw_reasoning_content(self) -> None:
        completion = SimpleNamespace(
            id="chat_private_reasoning",
            choices=[SimpleNamespace(message=SimpleNamespace(
                content="final answer",
                reasoning_content="private chain of thought",
                reasoning_summary="",
                tool_calls=[],
            ))],
            usage=SimpleNamespace(prompt_tokens=5, completion_tokens=2, total_tokens=7),
        )
        client = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock(return_value=completion))),
        )
        result = ProviderAdapter().invoke(
            client=client,
            provider_id="unknown",
            model="chat-test",
            messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "answer"}],
            tools=TOOLS,
            require_tool=False,
            prefer_responses=False,
        )
        self.assertEqual(result["reasoning_summary"], "")

    def test_responses_retries_without_unsupported_reasoning_parameter(self) -> None:
        response = {
            "id": "resp_2",
            "output": [
                {"type": "function_call", "call_id": "call_3", "name": "inspect_canvas", "arguments": "{}"}
            ],
            "usage": {"input_tokens": 4, "output_tokens": 1},
        }
        create = Mock(side_effect=[RuntimeError("reasoning parameter is unsupported"), response])
        client = SimpleNamespace(
            responses=SimpleNamespace(create=create),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        result = ProviderAdapter().invoke(
            client=client,
            provider_id="bailian",
            model="qwen-test",
            messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "draw"}],
            tools=TOOLS,
            require_tool=True,
        )
        self.assertEqual(result["protocol"], "responses")
        self.assertTrue(result["reasoning_degraded"])
        self.assertNotIn("reasoning", create.call_args_list[-1].kwargs)
        client.chat.completions.create.assert_not_called()

    def test_responses_retries_required_tool_choice_as_auto(self) -> None:
        response = {
            "id": "resp_tool_choice",
            "output": [
                {"type": "function_call", "call_id": "call_4", "name": "inspect_canvas", "arguments": "{}"}
            ],
            "usage": {"input_tokens": 4, "output_tokens": 1},
        }
        create = Mock(side_effect=[RuntimeError("tool_choice required is not supported"), response])
        client = SimpleNamespace(
            responses=SimpleNamespace(create=create),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        result = ProviderAdapter().invoke(
            client=client,
            provider_id="doubao",
            model="doubao-test",
            messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "draw"}],
            tools=TOOLS,
            require_tool=True,
        )
        self.assertEqual(result["protocol"], "responses")
        self.assertEqual(create.call_args_list[0].kwargs["tool_choice"], "required")
        self.assertEqual(create.call_args_list[1].kwargs["tool_choice"], "auto")
        client.chat.completions.create.assert_not_called()

    def test_response_continuation_never_falls_back_after_tool_outputs(self) -> None:
        client = SimpleNamespace(
            responses=SimpleNamespace(create=Mock(side_effect=RuntimeError("expired"))),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        with self.assertRaises(RuntimeError):
            ProviderAdapter().invoke(
                client=client,
                provider_id="doubao",
                model="doubao-test",
                messages=[{"role": "system", "content": "system"}],
                tools=TOOLS,
                require_tool=True,
                previous_response_id="resp_old",
                tool_outputs=[{"tool_call_id": "call_1", "content": "ok"}],
            )
        client.chat.completions.create.assert_not_called()

    def test_response_continuation_includes_visual_review_input(self) -> None:
        response = {
            "id": "resp_visual",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "looks good"}]}],
            "usage": {"input_tokens": 20, "output_tokens": 3},
        }
        create = Mock(return_value=response)
        client = SimpleNamespace(
            responses=SimpleNamespace(create=create),
            chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())),
        )
        ProviderAdapter().invoke(
            client=client,
            provider_id="doubao",
            model="doubao-test",
            messages=[{"role": "system", "content": "system"}],
            tools=TOOLS,
            require_tool=False,
            previous_response_id="resp_old",
            tool_outputs=[{"tool_call_id": "call_1", "content": "ok"}],
            additional_input_items=[{
                "role": "user",
                "content": [{"type": "input_image", "file_id": "file_review"}],
            }],
        )
        request_input = create.call_args.kwargs["input"]
        self.assertEqual(request_input[0]["type"], "function_call_output")
        self.assertEqual(request_input[1]["content"][0]["file_id"], "file_review")
        self.assertEqual(create.call_args.kwargs["instructions"], "system")
        self.assertEqual(create.call_args.kwargs["previous_response_id"], "resp_old")
        self.assertTrue(create.call_args.kwargs["store"])


if __name__ == "__main__":
    unittest.main()
