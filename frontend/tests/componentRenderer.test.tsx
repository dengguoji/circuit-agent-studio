import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComponentRenderer, getComponentBounds } from "../src/ComponentRenderer";
import type { ComponentDetail, ComponentInstance, ComponentProperty, ComponentRenderShape, Orientation } from "../src/circuitTools";


function detail(flags: string[], shapes: ComponentRenderShape[]): ComponentDetail {
  return {
    id: null,
    name: "Render test",
    requested_name: "Render test",
    category: "test",
    path: "render-test.xml",
    minsize: "40",
    properties: [],
    property_defaults: {},
    configurations: [],
    matched_configuration: null,
    suggested_properties: {},
    aliases: [],
    flags,
    connections: [],
    render: { autorotate: "", shapes },
    definitions: { consts: {}, defs: {} },
  };
}


function verticalComponent(componentDetail: ComponentDetail): ComponentInstance {
  return {
    id: "cmp_1",
    name: componentDetail.name,
    requestedName: componentDetail.name,
    origin: [100, 100],
    orientation: "v",
    size: 40,
    properties: {},
    detail: componentDetail,
  };
}

function property(name: string): ComponentProperty {
  return {
    name,
    type: "string",
    default: "",
    serialize: name.toLowerCase(),
    display: name,
    options: [],
  };
}

function componentWithText(
  componentDetail: ComponentDetail,
  orientation: Orientation,
  properties: Record<string, string>
): ComponentInstance {
  return {
    id: "cmp_text",
    name: componentDetail.name,
    requestedName: componentDetail.name,
    origin: [100, 100],
    orientation,
    size: 40,
    properties,
    detail: componentDetail,
  };
}


describe("component orientation rendering", () => {
  const plainLine: ComponentRenderShape = {
    type: "line",
    conditions: "",
    autorotate: "",
    attrs: { start: "_Start", end: "_End" },
  };

  it("auto-rotates an unrestricted asset that has no orientation-specific geometry", () => {
    const markup = renderToStaticMarkup(
      <svg><ComponentRenderer component={verticalComponent(detail([], [plainLine]))} active={false} /></svg>
    );

    expect(markup).toContain('transform="rotate(90)"');
  });

  it("does not attempt to rotate a HorizontalOnly asset", () => {
    const markup = renderToStaticMarkup(
      <svg><ComponentRenderer component={verticalComponent(detail(["HorizontalOnly"], [plainLine]))} active={false} /></svg>
    );

    expect(markup).not.toContain('transform="rotate(90)"');
  });

  it("uses an asset's explicit vertical geometry without adding another rotation", () => {
    const verticalLine: ComponentRenderShape = {
      ...plainLine,
      conditions: "!horizontal",
    };
    const horizontalLine: ComponentRenderShape = {
      ...plainLine,
      conditions: "horizontal",
    };
    const markup = renderToStaticMarkup(
      <svg>
        <ComponentRenderer
          component={verticalComponent(detail([], [horizontalLine, verticalLine]))}
          active={false}
        />
      </svg>
    );

    expect(markup).not.toContain('transform="rotate(90)"');
    expect((markup.match(/<line/g) ?? []).length).toBe(1);
  });
});

describe("component label and value rendering", () => {
  const universalLabel: ComponentRenderShape = {
    type: "text",
    conditions: "horizontal,$Text",
    autorotate: "Off",
    attrs: {
      value: "$Text",
      x: "_Middle",
      y: "_Middle-24y",
      align: "BottomCentre",
      "data-role": "universal-label",
    },
  };
  const verticalUniversalLabel: ComponentRenderShape = {
    ...universalLabel,
    conditions: "!horizontal,$Text",
    attrs: {
      ...universalLabel.attrs,
      x: "_Middle+24x",
      y: "_Middle",
      align: "CentreLeft",
    },
  };

  it("places an injected label outside both the symbol lane and an existing parameter value", () => {
    const sourceDetail: ComponentDetail = {
      ...detail([], [
        {
          type: "text",
          conditions: "$ShowVoltage",
          autorotate: "Off",
          attrs: { value: "$Voltage", x: "_Middle", y: "_Middle-60", align: "BottomCentre", size: "large" },
        },
        universalLabel,
      ]),
      name: "Source",
      properties: [property("Voltage"), property("ShowVoltage"), property("Text")],
    };
    const component = componentWithText(sourceDetail, "h", { Voltage: "9 V", ShowVoltage: "true", Text: "V1" });
    const markup = renderToStaticMarkup(<svg><ComponentRenderer component={component} active={false} /></svg>);

    expect(markup).toContain(">9 V</text>");
    expect(markup).toContain('y="-83.6"');
    expect(markup).toContain(">V1</text>");
    expect(getComponentBounds(component).y).toBeLessThan(20);
  });

  it("moves a vertical injected label beyond an auto-rotated parameter value", () => {
    const sourceDetail: ComponentDetail = {
      ...detail([], [
        {
          type: "text",
          conditions: "$ShowVoltage",
          autorotate: "HorizontalToVertical",
          attrs: { value: "$Voltage", x: "_Middle", y: "_Middle-60", align: "BottomCentre", size: "large" },
        },
        verticalUniversalLabel,
      ]),
      name: "Source",
      properties: [property("Voltage"), property("ShowVoltage"), property("Text")],
      render: {
        autorotate: "HorizontalToVertical",
        shapes: [
          {
            type: "text",
            conditions: "$ShowVoltage",
            autorotate: "HorizontalToVertical",
            attrs: { value: "$Voltage", x: "_Middle", y: "_Middle-60", align: "BottomCentre", size: "large" },
          },
          verticalUniversalLabel,
        ],
      },
    };
    const component = componentWithText(sourceDetail, "v", { Voltage: "9 V", ShowVoltage: "true", Text: "V1" });
    const markup = renderToStaticMarkup(<svg><ComponentRenderer component={component} active={false} /></svg>);

    expect(markup).toContain('transform="rotate(90)"');
    expect(markup).toContain('x="83.6"');
    expect(markup).toContain(">V1</text>");
  });

  it("keeps an asset's native Reference and Value text without adding a duplicate label", () => {
    const diodeDetail: ComponentDetail = {
      ...detail([], [
        { type: "text", conditions: "$Reference", autorotate: "Off", attrs: { value: "$Reference", x: "_Middle", y: "_Middle-23", align: "BottomCentre" } },
        { type: "text", conditions: "$Value", autorotate: "Off", attrs: { value: "$Value", x: "_Middle", y: "_Middle-13", align: "BottomCentre" } },
      ]),
      name: "Alternative Diode",
      properties: [property("Reference"), property("Value")],
    };
    const component = componentWithText(diodeDetail, "h", { Reference: "D1", Value: "1N4148" });
    const markup = renderToStaticMarkup(<svg><ComponentRenderer component={component} active={false} /></svg>);

    expect(markup).toContain(">D1</text>");
    expect(markup).toContain(">1N4148</text>");
    expect((markup.match(/<text/g) ?? []).length).toBe(2);
  });

  it("preserves a native Text and Resistance pair at the XML-defined positions", () => {
    const resistorDetail: ComponentDetail = {
      ...detail([], [
        { type: "text", conditions: "$ShowResistance", autorotate: "Off", attrs: { value: "$Resistance", x: "_Middle", y: "_Middle-14", align: "BottomCentre" } },
        { type: "text", conditions: "$Text", autorotate: "Off", attrs: { value: "$Text", x: "_Middle", y: "_Middle-30", align: "BottomCentre" } },
      ]),
      name: "Resistor",
      properties: [property("Resistance"), property("ShowResistance"), property("Text")],
    };
    const component = componentWithText(resistorDetail, "h", { Resistance: "10 kΩ", ShowResistance: "true", Text: "R1" });
    const markup = renderToStaticMarkup(<svg><ComponentRenderer component={component} active={false} /></svg>);

    expect(markup).toContain('y="-14"');
    expect(markup).toContain(">10 kΩ</text>");
    expect(markup).toContain('y="-30"');
    expect(markup).toContain(">R1</text>");
  });
});
