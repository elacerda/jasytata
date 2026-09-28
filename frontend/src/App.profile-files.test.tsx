import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createBundledProfileRegistry, type ProfileRegistry } from "./profiles/registry";
import { parseProfileJson, serializeProfile } from "./profiles/document";
import smallJson from "./profiles/fixtures/small-camera.json";

const session = vi.hoisted(() => ({ registry: null as ProfileRegistry | null }));
vi.mock("./profiles", async (importOriginal) => {
  const original = await importOriginal<typeof import("./profiles")>();
  const { resolvePlanningProfile } = await import("./profiles/planning");
  const registry = new Proxy({} as ProfileRegistry, {
    get: (_, key) => {
      const value = Reflect.get(session.registry!, key);
      return typeof value === "function" ? value.bind(session.registry) : value;
    },
  });
  return { ...original, profileRegistry: registry, loadProfile: (id = original.DEFAULT_PROFILE.id) => resolvePlanningProfile(id, undefined, registry).profile };
});
vi.mock("./AladinMap", () => ({ default: () => <div aria-label="Sky map" /> }));

function jsonFile(text: string, name = "profile.json"): File {
  const file = new File([text], name, { type: "application/json" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("minimal browser profile file controls", () => {
  beforeEach(() => { session.registry = createBundledProfileRegistry(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("imports a file, shows success and selector entries, and activates the registered survey", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("splus-t80-south"));
    const input = screen.getByLabelText("Profile JSON file");
    const click = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Import profile" }));
    expect(click).toHaveBeenCalledOnce();
    await user.upload(input, jsonFile(JSON.stringify(smallJson)));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported profile: Small oblique survey");
    const selector = screen.getByRole("combobox", { name: "Profile" });
    expect(within(selector).getByRole("option", { name: "Small oblique survey" })).toBeTruthy();
    expect(session.registry!.listInstrumentProfiles().map(({ id }) => id)).toContain("small-camera");
    await user.selectOptions(selector, "small-survey");
    expect(selector).toHaveValue("small-survey");
    expect(screen.getByRole("button", { name: "Export profile JSON" })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
    fetchMock.mockResolvedValue(new Response("RA,DEC\n150,-30\n"));
    await user.click(screen.getByRole("button", { name: /load reference/i }));
    const instrumentSelector = await screen.findByRole("combobox", { name: "Instrument profile for tiles_nc.csv" });
    expect(within(instrumentSelector).getByRole("option", { name: "Small circular camera" })).toBeTruthy();
  });

  it("reports malformed/scientifically invalid files and duplicate IDs without partial imports", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("splus-t80-south"));
    const input = screen.getByLabelText("Profile JSON file");
    await user.upload(input, jsonFile("{"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Malformed profile JSON");
    await user.upload(input, jsonFile(JSON.stringify({ ...smallJson, instrument: { ...smallJson.instrument, footprint: { type: "circle", radius_deg: 0 } } })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Circle radius");
    expect(session.registry!.listInstrumentProfiles()).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Small oblique survey" })).toBeNull();
    await user.upload(input, jsonFile(serializeProfile(session.registry!.resolveProfileDocument("splus-t80-south"))));
    expect(await screen.findByRole("alert")).toHaveTextContent('Instrument profile ID "t80-south" is already registered');
    expect(session.registry!.listSurveyProfiles()).toHaveLength(1);
  });

  it("rejects a file conflicting with the active inline draft and permits that ID in a fresh session", async () => {
    const user = userEvent.setup();
    const customId = { ...smallJson, survey: { ...smallJson.survey, id: "custom" } };
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("splus-t80-south"));
    await user.click(screen.getByRole("button", { name: "Create custom profile" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("custom"));
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(customId)));
    expect(await screen.findByRole("alert")).toHaveTextContent("already used by the active custom draft");
    expect(session.registry!.listInstrumentProfiles()).toHaveLength(1);
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "splus-t80-south");
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(customId)));
    await screen.findByText(/Imported profile:/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "custom");
    expect(screen.getByRole("button", { name: "Export profile JSON" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Create custom profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('imported survey ID "custom" is in use');
  });

  it("downloads the active profile as canonical JSON with a deterministic safe filename", async () => {
    const user = userEvent.setup();
    let downloaded: Blob | undefined;
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { downloaded = blob; return "blob:profile-test"; });
      static revokeObjectURL = vi.fn();
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("small-survey.json");
      expect(this.href).toBe("blob:profile-test");
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("splus-t80-south"));
    await user.upload(screen.getByLabelText("Profile JSON file"), jsonFile(JSON.stringify(smallJson)));
    await screen.findByText(/Imported profile:/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Profile" }), "small-survey");
    await user.click(screen.getByRole("button", { name: "Export profile JSON" }));
    expect(click).toHaveBeenCalledOnce();
    expect(downloaded!.type).toBe("application/json; charset=utf-8");
    const text = await blobText(downloaded!);
    expect(text).toBe(serializeProfile(session.registry!.resolveProfileDocument("small-survey")));
    expect(parseProfileJson(text).survey.id).toBe("small-survey");
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:profile-test"));
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
