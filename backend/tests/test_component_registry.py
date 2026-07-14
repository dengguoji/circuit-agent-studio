from __future__ import annotations

import unittest

from component_registry import get_component_detail, load_registry


class ComponentOrientationRegistryTests(unittest.TestCase):
    def test_all_asset_orientation_flags_are_parsed_and_normalized(self) -> None:
        registry = load_registry()
        self.assertEqual(registry["errors"], [])
        self.assertEqual(len(registry["components"]), registry["component_list_count"])

        restricted = []
        for component in registry["components"]:
            flags = component.get("flags")
            self.assertIsInstance(flags, list, component["name"])
            self.assertFalse(
                {"HorizontalOnly", "VerticalOnly"}.issubset(set(flags)),
                f'{component["name"]} has conflicting orientation flags',
            )
            if "HorizontalOnly" in flags or "VerticalOnly" in flags:
                restricted.append(component["name"])

        self.assertEqual(len(restricted), 30)
        self.assertIn("Adder", restricted)
        self.assertIn("D Flip-Flop", restricted)
        self.assertIn("Transformer", restricted)

    def test_legacy_flag_spellings_share_one_canonical_value(self) -> None:
        details = get_component_detail(["Adder", "D Flip-Flop", "Transformer"])
        self.assertEqual(details["missing"], [])
        for component in details["components"]:
            self.assertIn("HorizontalOnly", component["flags"])
            self.assertNotIn("horizontalonly", component["flags"])

    def test_reference_and_text_are_mutually_exclusive_label_channels(self) -> None:
        registry = load_registry()
        for component in registry["components"]:
            property_names = {prop["name"] for prop in component["properties"]}
            universal_shapes = [
                shape
                for shape in component["render"]["shapes"]
                if shape["attrs"].get("data-role") == "universal-label"
            ]
            self.assertFalse(
                {"Reference", "Text"}.issubset(property_names),
                f'{component["name"]} exposes duplicate label properties',
            )
            if "Reference" in property_names:
                self.assertEqual(universal_shapes, [], component["name"])
            elif "Text" in property_names and universal_shapes:
                self.assertEqual(len(universal_shapes), 2, component["name"])

        details = get_component_detail(["Alternative Diode", "Resistor", "Source", "Voltmeter"])
        by_request = {component["requested_name"]: component for component in details["components"]}

        diode_properties = {prop["name"] for prop in by_request["Alternative Diode"]["properties"]}
        self.assertIn("Reference", diode_properties)
        self.assertIn("Value", diode_properties)
        self.assertNotIn("Text", diode_properties)

        resistor = by_request["Resistor"]
        self.assertIn("Text", {prop["name"] for prop in resistor["properties"]})
        self.assertIn("Resistance", {prop["name"] for prop in resistor["properties"]})
        self.assertFalse(any(shape["attrs"].get("data-role") for shape in resistor["render"]["shapes"]))

        for request_name in ("Source", "Voltmeter"):
            component = by_request[request_name]
            self.assertIn("Text", {prop["name"] for prop in component["properties"]})
            self.assertEqual(
                sum(shape["attrs"].get("data-role") == "universal-label" for shape in component["render"]["shapes"]),
                2,
            )


if __name__ == "__main__":
    unittest.main()
