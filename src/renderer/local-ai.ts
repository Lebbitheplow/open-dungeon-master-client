// Story AI for the device world: who narrates (a human, OpenAI by key, or
// a local model on this machine), the guided local install with its
// progress, the optional image stack, and the OpenAI key form.
import { backLink, formCard, intro, loadingScreen, show } from "./chrome.js";
import { button, chip, el, input } from "./dom.js";
import type { IconName } from "./dom.js";
import { renderHome } from "./home.js";
import { renderError } from "./servers.js";
import { isAndroid, state } from "./state.js";
import type { AiSetup, HardwareInfo, LocalAiStatus, LocalAiTier } from "../shared/types";

// The live progress bar of an install in flight, for the progress events to
// fill; null when nothing is downloading.
export const aiProgress: { current: { fill: HTMLElement; label: HTMLElement } | null } = {
  current: null,
};

function choice(
  iconName: IconName,
  title: string,
  desc: string,
  onClick?: () => void,
  tag = "",
): HTMLButtonElement {
  const btn = el("button", "panel ornate choice");
  btn.type = "button";
  btn.append(chip(iconName));
  const text = el("span", "text");
  const heading = el("span", "title", title);
  if (tag) heading.append(el("span", "tag", tag));
  text.append(heading, el("span", "desc", desc));
  btn.append(text);
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}

export function renderLocalAi(fromHome = false, aiStatus: LocalAiStatus | null = null): void {
  state.screenName = "local-ai";
  if (fromHome && !aiStatus) {
    // The entry screen doubles as the status view; fetch once, then re-render
    // with the installed-components card filled in.
    void window.odm.localAiStatus().then((status) => {
      if (state.screenName === "local-ai") renderLocalAi(true, status);
    });
  }
  const choices = el("div", "choices");
  choices.append(
    choice("user", "A human Dungeon Master", "No AI at all. You or a friend runs the table.", () =>
      void finishAi({ choice: "human", apiKey: "", model: "", utilityModel: "" }),
    ),
    choice(
      "key",
      "AI Dungeon Master via your OpenAI API key",
      "Narration and image generation billed to your key. No GPU needed.",
      () => renderOpenAiForm(),
    ),
  );
  // Local models need a desktop GPU; a phone gets the two doors above.
  if (!isAndroid) {
    choices.append(
      choice(
        "cpu",
        "Local AI on this machine",
        "Free and private: a guided install sized to your hardware. Needs a beefy machine.",
        () => void startLocalAiFlow(),
      ),
    );
  }
  show(
    "mid",
    fromHome ? backLink("Home", () => renderHome()) : null,
    intro(
      "Who runs your games?",
      "You can change this any time from the Story AI button on the home screen.",
    ),
    localAiStatusCard(aiStatus),
    choices,
  );
}

// What is installed on this machine right now, with per-component removal.
function localAiStatusCard(status: LocalAiStatus | null): HTMLElement | null {
  if (!status || (!status.installedTierId && !status.comfy.installed)) return null;
  const card = el("div", "panel card");
  const head = el("div", "head");
  head.append(chip("cpu"));
  const grow = el("div", "grow");
  grow.append(el("div", "name", "Installed on this machine"));
  if (status.installedTierId) {
    const utility = status.utilityInstalled ? " + utility model" : "";
    grow.append(
      el(
        "div",
        "detail",
        `${status.installedLabel || "Story model"}${utility}: ${status.running ? "running" : "stopped"}.`,
      ),
    );
  }
  if (status.comfy.installed) {
    grow.append(
      el("div", "detail", `Image generation (ComfyUI): ${status.comfy.running ? "running" : "stopped"}.`),
    );
  }
  head.append(grow);
  card.append(head);
  const actions = el("div", "actions");
  const uninstall = (label: string, component: "text" | "images", prompt: string): void => {
    actions.append(
      button("quiet danger", label, (btn) => {
        if (!confirm(prompt)) return;
        btn.disabled = true;
        void window.odm.localAiUninstall(component).then((result) => {
          if (result.ok) renderLocalAi(true, result.status);
          else renderError(result.error);
        });
      }),
    );
  };
  if (status.installedTierId) {
    uninstall(
      "Uninstall story AI",
      "text",
      "Delete the local story model and AI engine? Your campaigns stay; the AI stops until you set one up again.",
    );
  }
  if (status.comfy.installed) {
    uninstall(
      "Uninstall image AI",
      "images",
      "Delete ComfyUI and the image model? Existing campaign art stays.",
    );
  }
  card.append(actions);
  card.style.marginBottom = "1.25rem";
  return card;
}

// ---------- local AI installer ----------

async function startLocalAiFlow(): Promise<void> {
  state.screenName = "local-ai-scan";
  show("narrow", loadingScreen("Checking this machine", "Measuring memory and graphics hardware..."));
  const result = await window.odm.localAiScan();
  if (!result.ok) {
    renderError(result.error);
    return;
  }
  renderLocalAiTiers(result.hardware, result.tiers);
}

function renderLocalAiTiers(hardware: HardwareInfo, tiers: LocalAiTier[]): void {
  state.screenName = "local-ai-tiers";
  const gpu = hardware.gpuName || "This machine";
  const memory = hardware.unifiedMemory
    ? `${hardware.ramGb} GB unified memory`
    : `${hardware.vramGb} GB graphics memory, ${hardware.ramGb} GB RAM`;
  const choices = el("div", "choices");
  for (const tier of tiers) {
    const tag = tier.installed ? "installed" : tier.recommended ? "recommended" : "";
    const desc = `${tier.detail} ${tier.sizeGb} GB download${
      tier.fits ? "" : `; needs about ${tier.needsGb} GB of memory`
    }.`;
    const btn = choice(
      "sparkles",
      tier.label,
      desc,
      tier.fits ? () => renderLocalAiInstall(tier) : undefined,
      tag,
    );
    btn.disabled = !tier.fits;
    choices.append(btn);
  }
  show(
    "mid",
    backLink("Story AI", () => renderLocalAi()),
    intro("Pick your storyteller", `${gpu}: ${memory}. Greyed-out choices need more memory.`),
    choices,
  );
}

function progressCard(label: HTMLElement): { card: HTMLElement; fill: HTMLElement } {
  const card = el("div", "glass grain form-card");
  const bar = el("div", "progress");
  const fill = el("div", "progress-fill");
  bar.append(fill);
  card.append(bar, label);
  return { card, fill };
}

function renderLocalAiInstall(tier: LocalAiTier): void {
  state.screenName = "local-ai-install";
  const label = el("p", "hint", "Starting...");
  const { card, fill } = progressCard(label);
  aiProgress.current = { fill, label };
  show(
    "narrow",
    intro(
      `Setting up ${tier.label.toLowerCase()}`,
      "Keep the app open. Large downloads resume where they left off if interrupted.",
    ),
    card,
  );
  void window.odm.localAiInstall(tier.id).then((result) => {
    aiProgress.current = null;
    if (!result.ok) {
      show(
        "narrow",
        backLink("Story AI", () => void startLocalAiFlow()),
        intro(`Setting up ${tier.label.toLowerCase()}`, ""),
        formCard(el("p", "error", result.error)),
      );
      return;
    }
    // Next stop: images, unless ComfyUI is already there. A wiring warning
    // rides along so it is seen before the world swallows the screen.
    if (result.status.comfy.installed) {
      if (result.warning) renderWarning(result.warning);
      else void enterLocalWorld();
    } else {
      renderComfyOffer(result.warning);
    }
  });
}

async function enterLocalWorld(): Promise<void> {
  await window.odm.localPlay(state.joinIntent?.code);
  state.joinIntent = null;
}

// Success with a caveat: something installed fine but its settings PATCH
// failed. One screen, one Continue, no pretending it fully worked.
function renderWarning(warning: string): void {
  state.screenName = "local-ai-warning";
  const card = formCard(el("p", "error", warning));
  const cont = button("primary", "Continue", () => void enterLocalWorld(), "play");
  cont.classList.add("block");
  card.append(cont);
  show("narrow", intro("Installed, with one loose end", ""), card);
}

function renderComfyOffer(warning: string): void {
  state.screenName = "local-ai-comfy";
  const choices = el("div", "choices");
  choices.append(
    choice(
      "image",
      "Install image generation (ComfyUI)",
      "One big download now; scene images in your campaigns from then on.",
      () => renderComfyInstall(),
    ),
    choice("play", "Skip for now", "Play with the story model only. You can add images later.", () =>
      void enterLocalWorld(),
    ),
  );
  show(
    "mid",
    intro(
      "Add local image generation?",
      "ComfyUI with the Stable Diffusion XL model paints scene art on your GPU, free and private. About 15 GB all told (Python packages included); needs Python 3 and Git installed. You can remove it later from the Story AI screen.",
    ),
    warning ? el("p", "error", warning) : null,
    choices,
  );
}

function renderComfyInstall(): void {
  state.screenName = "local-ai-comfy-install";
  const label = el("p", "hint", "Starting...");
  const { card, fill } = progressCard(label);
  aiProgress.current = { fill, label };
  show(
    "narrow",
    intro(
      "Setting up image generation",
      "Keep the app open. The big downloads resume where they left off if interrupted.",
    ),
    card,
  );
  void window.odm.localAiInstallComfy().then((result) => {
    aiProgress.current = null;
    if (!result.ok) {
      show(
        "narrow",
        backLink("Back", () => renderComfyOffer("")),
        intro("Setting up image generation", ""),
        formCard(el("p", "error", result.error)),
      );
      return;
    }
    if (result.warning) renderWarning(result.warning);
    else void enterLocalWorld();
  });
}

function renderOpenAiForm(): void {
  state.screenName = "local-ai-openai";
  const form = el("form");
  const [keyLabel, keyField] = input("API key", "password");
  keyField.placeholder = "sk-...";
  const [modelLabel, modelField] = input("Dungeon Master model", "text", "gpt-5.1");
  const [utilityLabel, utilityField] = input("Utility model (cheaper, for summaries)", "text", "gpt-5-mini");
  const error = el("p", "error");
  const submit = button("primary", "Save and play");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(keyLabel, modelLabel, utilityLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const setup: AiSetup = {
      choice: "openai",
      apiKey: keyField.value.trim(),
      model: modelField.value.trim(),
      utilityModel: utilityField.value.trim(),
    };
    void finishAi(setup).catch(() => undefined).then(() => {
      submit.disabled = false;
    });
  });
  show(
    "narrow",
    backLink("Story AI", () => renderLocalAi()),
    intro(
      "Connect your OpenAI API key",
      "The key is stored by your local server and never shared with players.",
    ),
    formCard(form),
  );
  keyField.focus();
}

async function finishAi(setup: AiSetup): Promise<void> {
  const result = await window.odm.localConfigureAi(setup);
  if (!result.ok) {
    renderError(result.error);
    return;
  }
  await window.odm.localPlay(state.joinIntent?.code);
  state.joinIntent = null;
}
