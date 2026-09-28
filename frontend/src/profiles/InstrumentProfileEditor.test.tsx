import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentProfileEditor } from "./InstrumentProfileEditor";
import { validateInstrumentProfileV2 } from "./schema-v2";
import type { InstrumentProfileV2 } from "../types";
import smallProfileJson from "./fixtures/small-camera.json";

async function replaceValue(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const field = screen.getByRole("textbox", { name: label });
  await user.clear(field);
  if (value) await user.type(field, value);
}

async function fillIdentity(user: ReturnType<typeof userEvent.setup>, id = "new-camera", name = "New camera") {
  await replaceValue(user, "Instrument ID", id);
  await replaceValue(user, "Display name", name);
}

describe("Schema v2 instrument authoring draft", () => {
  afterEach(() => cleanup());

  it("opens a create-only draft and abandons it without saving", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<InstrumentProfileEditor onCancel={onCancel} />);

    expect(screen.getByRole("dialog", { name: "Create instrument profile" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Footprint type" })).toHaveValue("rectangle");
    await fillIdentity(user);
    expect(await screen.findByRole("status")).toHaveTextContent("Instrument valid");
    expect(screen.getByText(/A complete survey is still required/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("edits rectangle dimensions and PA through the shared instrument validator", async () => {
    const user = userEvent.setup();
    const onValidatedChange = vi.fn<(instrument: InstrumentProfileV2 | null) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onInstrumentValidatedChange={onValidatedChange} />);
    await fillIdentity(user);
    await replaceValue(user, "width (°)", "0.9");
    await replaceValue(user, "height (°)", "0.75");
    await replaceValue(user, "position angle (°)", "32.5");

    const expected = validateInstrumentProfileV2({
      schema_version: 2,
      id: "new-camera",
      display_name: "New camera",
      coordinate_frame: "icrs",
      footprint: { type: "rectangle", width_deg: 0.9, height_deg: 0.75, position_angle_deg: 32.5 },
    });
    await waitFor(() => expect(onValidatedChange).toHaveBeenLastCalledWith(expected));
    expect(screen.getByLabelText("Instrument footprint summary")).toHaveTextContent("Rectangle 0.9° × 0.75° · PA 32.5°");

    await replaceValue(user, "width (°)", "");
    expect(await screen.findByRole("alert")).toHaveTextContent("Finish the numeric field");
    expect(onValidatedChange).toHaveBeenLastCalledWith(null);
    await replaceValue(user, "width (°)", "0");
    expect(await screen.findByRole("alert")).toHaveTextContent("Rectangle width must be greater than 0");
    expect(onValidatedChange).toHaveBeenLastCalledWith(null);
  });

  it("edits circles, validates radius, and drops rectangle-only fields", async () => {
    const user = userEvent.setup();
    const onValidatedChange = vi.fn<(instrument: InstrumentProfileV2 | null) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onInstrumentValidatedChange={onValidatedChange} />);
    await fillIdentity(user, "small-camera", "Small circular camera");
    await user.selectOptions(screen.getByRole("combobox", { name: "Footprint type" }), "circle");
    expect(screen.queryByRole("textbox", { name: "width (°)" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "height (°)" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "position angle (°)" })).toBeNull();
    expect(screen.getByLabelText("Instrument footprint summary")).toHaveTextContent("Circle · radius 0.5°");
    await replaceValue(user, "radius (°)", "0.12");

    const expected = validateInstrumentProfileV2(smallProfileJson.instrument);
    await waitFor(() => expect(onValidatedChange).toHaveBeenLastCalledWith(expected));
    expect(expected.footprint).toEqual({ type: "circle", radius_deg: 0.12 });
    expect(expected.footprint).not.toHaveProperty("width_deg");
    expect(expected.footprint).not.toHaveProperty("height_deg");

    await replaceValue(user, "radius (°)", "0");
    expect(await screen.findByRole("alert")).toHaveTextContent("Circle radius must be greater than 0");
  });

  it("adds, edits, and removes polygon vertices without changing the remaining order", async () => {
    const user = userEvent.setup();
    const onValidatedChange = vi.fn<(instrument: InstrumentProfileV2 | null) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onInstrumentValidatedChange={onValidatedChange} />);
    await fillIdentity(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Footprint type" }), "polygon");
    expect(screen.getByRole("textbox", { name: "vertex 1 east (°)" })).toHaveValue("-0.5");
    await user.click(screen.getByRole("button", { name: "Add vertex" }));
    expect(screen.getByRole("textbox", { name: "vertex 5 east (°)" })).toHaveValue("0");
    await replaceValue(user, "vertex 2 east (°)", "0.75");
    await user.click(screen.getByRole("button", { name: "Remove vertex 5" }));

    const expected = validateInstrumentProfileV2({
      schema_version: 2,
      id: "new-camera",
      display_name: "New camera",
      coordinate_frame: "icrs",
      footprint: {
        type: "polygon",
        vertices_deg: [[-0.5, -0.5], [0.75, -0.5], [0.5, 0.5], [-0.5, 0.5]],
        position_angle_deg: 0,
      },
    });
    await waitFor(() => expect(onValidatedChange).toHaveBeenLastCalledWith(expected));
    expect((expected.footprint as { vertices_deg: number[][] }).vertices_deg).toEqual([
      [-0.5, -0.5], [0.75, -0.5], [0.5, 0.5], [-0.5, 0.5],
    ]);

    await user.click(screen.getByRole("button", { name: "Remove vertex 4" }));
    await user.click(screen.getByRole("button", { name: "Remove vertex 3" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Polygon must have at least three vertices");
  });

  it("edits compound offsets, child rotations, child geometry types, and parent PA", async () => {
    const user = userEvent.setup();
    const onValidatedChange = vi.fn<(instrument: InstrumentProfileV2 | null) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onInstrumentValidatedChange={onValidatedChange} />);
    await fillIdentity(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Footprint type" }), "compound");
    const childType = screen.getByRole("combobox", { name: "Component 2 footprint type" });
    expect(Array.from((childType as HTMLSelectElement).options, (option) => option.value)).toEqual(["rectangle", "circle", "polygon"]);
    await replaceValue(user, "Mosaic position angle (°)", "12.5");
    await replaceValue(user, "Component 1 offset east (°)", "-0.75");
    await replaceValue(user, "Component 1 offset north (°)", "0.1");
    await replaceValue(user, "Component 1 rotation (°)", "15");
    await replaceValue(user, "Component 1 position angle (°)", "6");
    await user.selectOptions(childType, "polygon");
    await replaceValue(user, "Component 2 offset east (°)", "0.8");
    await replaceValue(user, "Component 2 offset north (°)", "-0.2");
    await replaceValue(user, "Component 2 rotation (°)", "-10");
    await replaceValue(user, "Component 2 position angle (°)", "3.5");

    const expected = validateInstrumentProfileV2({
      schema_version: 2,
      id: "new-camera",
      display_name: "New camera",
      coordinate_frame: "icrs",
      footprint: {
        type: "compound",
        position_angle_deg: 12.5,
        components: [
          {
            offset_deg: [-0.75, 0.1],
            rotation_deg: 15,
            footprint: { type: "rectangle", width_deg: 1.4, height_deg: 1.4, position_angle_deg: 6 },
          },
          {
            offset_deg: [0.8, -0.2],
            rotation_deg: -10,
            footprint: {
              type: "polygon",
              vertices_deg: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
              position_angle_deg: 3.5,
            },
          },
        ],
      },
    });
    await waitFor(() => expect(onValidatedChange).toHaveBeenLastCalledWith(expected));
    expect(expected.footprint.type).toBe("compound");
    if (expected.footprint.type !== "compound") throw new Error("Expected compound footprint");
    expect(expected.footprint.components.map(({ footprint }) => footprint.type)).toEqual(["rectangle", "polygon"]);
    expect(expected.footprint.components.map(({ offset_deg, rotation_deg }) => ({ offset_deg, rotation_deg }))).toEqual([
      { offset_deg: [-0.75, 0.1], rotation_deg: 15 },
      { offset_deg: [0.8, -0.2], rotation_deg: -10 },
    ]);
    expect(expected.footprint.position_angle_deg).toBe(12.5);
  });

  it("resets a draft back to a blank Schema v2 instrument without saving", async () => {
    const user = userEvent.setup();
    const onValidatedChange = vi.fn<(instrument: InstrumentProfileV2 | null) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onInstrumentValidatedChange={onValidatedChange} />);
    await fillIdentity(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Footprint type" }), "circle");
    await replaceValue(user, "radius (°)", "0.25");
    expect(await screen.findByRole("status")).toHaveTextContent("Instrument valid");

    await user.click(screen.getByRole("button", { name: "Reset draft" }));

    expect(screen.getByRole("textbox", { name: "Instrument ID" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Footprint type" })).toHaveValue("rectangle");
    expect(screen.getByRole("textbox", { name: "width (°)" })).toHaveValue("1.4");
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid profile identifier");
    expect(onValidatedChange).toHaveBeenLastCalledWith(null);
  });

  it("matches a JSON fixture after building the same circle through editor fields", async () => {
    const user = userEvent.setup();
    const onValidatedChange = vi.fn<(instrument: InstrumentProfileV2 | null) => void>();
    render(<InstrumentProfileEditor onCancel={vi.fn()} onInstrumentValidatedChange={onValidatedChange} />);
    await fillIdentity(user, "small-camera", "Small circular camera");
    await user.selectOptions(screen.getByRole("combobox", { name: "Footprint type" }), "circle");
    await replaceValue(user, "radius (°)", "0.12");

    const fromJson = validateInstrumentProfileV2(smallProfileJson.instrument);
    await waitFor(() => expect(onValidatedChange).toHaveBeenLastCalledWith(fromJson));
    expect(onValidatedChange.mock.lastCall?.[0]).toEqual(fromJson);
  });
});
