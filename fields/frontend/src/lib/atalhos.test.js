import { describe, expect, it } from "vitest";
import { ehAtalhoDoComposer, ehMac, rotuloDoAtalho } from "./atalhos.js";

describe("ehAtalhoDoComposer", () => {
  it.each([
    [{ key: "k", ctrlKey: true }, true],
    [{ key: "k", metaKey: true }, true],
    [{ key: "K", ctrlKey: true }, true], // Caps Lock
    [{ key: "k" }, false],
    [{ key: "k", ctrlKey: true, shiftKey: true }, false],
    [{ key: "k", ctrlKey: true, altKey: true }, false],
    [{ key: "j", ctrlKey: true }, false],
    [{ key: "k", ctrlKey: true, repeat: true }, false], // tecla segurada não navega a cada repetição
    [{ key: "k", ctrlKey: true, isComposing: true }, false], // IME
    [null, false],
  ])("%j → %s", (evento, esperado) => {
    expect(ehAtalhoDoComposer(evento)).toBe(esperado);
  });
});

describe("rótulo do atalho", () => {
  it.each([
    [{ userAgentData: { platform: "macOS" } }, true, "⌘K"],
    [{ platform: "MacIntel" }, true, "⌘K"],
    [{ platform: "iPad" }, true, "⌘K"],
    [{ userAgentData: { platform: "Windows" }, platform: "Win32" }, false, "Ctrl+K"],
    [{ platform: "Linux x86_64" }, false, "Ctrl+K"],
    [{}, false, "Ctrl+K"],
  ])("%j", (nav, mac, rotulo) => {
    expect(ehMac(nav)).toBe(mac);
    expect(rotuloDoAtalho(nav)).toBe(rotulo);
  });
});
