// dsh-plugin-glass — host half.
//
// Injects the translucent "glass" stylesheet plus a head script that arms the
// stylesheet and asks the patched desktop shell for the native window material.
// Parameter values are read on every index render, so a settings write shows up
// on the next page load; the client half applies changes live in between.
import z from "@deepseek-ai/schemastery";

/** Marker attribute the stylesheet keys on; set by the injected head script. */
const GLASS_ATTRIBUTE = "dsh-glass";
/** Native materials the patched shell accepts. */
const MATERIALS = ["acrylic", "mica", "tabbed", "none"];
/** Scopes for the translucent wall: only the sidebar, or the whole window. */
const SCOPES = ["sidebar", "window"];
/** Surface tints mirror the palette DSH already uses for the Windows caption fallback. */
const TINT_LIGHT = { wall: "255,255,255", sidebar: "249,250,251" };
const TINT_DARK = { wall: "21,21,23", sidebar: "27,27,28" };

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  material: z.union(MATERIALS).default("acrylic").volatile(),
  scope: z.union(SCOPES).default("sidebar").volatile(),
  sidebarAlpha: z.number().step(1).min(0).max(100).default(65).volatile(),
  contentAlpha: z.number().step(1).min(0).max(100).default(35).volatile(),
  opaqueContent: z.number().step(1).min(0).max(100).default(100).volatile(),
  blurPx: z.number().step(1).min(0).max(60).default(18).volatile()
});

/** Clamp one 0-100 parameter and render it as a CSS alpha channel. */
function alpha(value) {
  const number = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? number : 0)) / 100;
}

/** Whether the glass treatment is actually active for this configuration. */
function isActive(config) {
  return config.enabled !== false && config.material !== "none";
}

/**
 * Build the glass stylesheet.
 *
 * Four things the shell's own layout does on Windows that would otherwise fight the acrylic:
 *  1. `body` paints `--dsw-alias-bg-base` as the window canvas.
 *  2. `.BynINW_frame` paints `--dsw-specific-sidebar-fill` across the whole window. Upstream
 *     clears the frame only under `data-platform="darwin"`
 *     (`html[data-platform=darwin] .BynINW_frame{background:0 0}`), and Windows has no such rule,
 *     so the acrylic stayed covered.
 *  3. The frame declares `--dsh-windows-content-radius:16px`, which leaves a bare-acrylic notch at
 *     the content column's top-left corner — a third transparency in the seam.
 *  4. Windows fills the caption-button rectangle with the sidebar tint, which stacks on top of the
 *     title-bar strip and makes that corner more opaque than the rest of the bar.
 *
 * `[data-dsh-glass-wall]` and `[data-dsh-glass-column]` are runtime tags the client half applies,
 * so the rules survive a renamed hashed class.
 */
function glassStyle(config) {
  const sidebar = alpha(config.sidebarAlpha);
  const content = alpha(config.scope === "window" ? config.contentAlpha : config.opaqueContent);
  const blur = Math.max(0, Math.min(60, Number(config.blurPx) || 0));
  const gate = `html[data-${GLASS_ATTRIBUTE}="on"]`;
  const dark = `${gate} body[data-ds-dark-theme]`;
  return [
    `${gate},${gate} body{background:transparent !important}`,
    `${gate} .BynINW_frame,${gate} [data-dsh-glass-wall]{background:transparent !important}`,
    // Square off the content column so the seam has no hole showing bare acrylic.
    `${gate} .BynINW_frame,${gate} [data-dsh-glass-wall]{--dsh-windows-content-radius:0px !important}`,
    `${gate} .BynINW_centerCol,${gate} [data-dsh-glass-column]{border-radius:0 !important}`,
    // The caption buttons read their fill from this probe; transparent keeps the bar uniform.
    `${gate} body > span[style*="--dsw-specific-sidebar-fill"]{background-color:transparent !important}`,
    `${gate} body{--dsw-specific-sidebar-fill:rgba(${TINT_LIGHT.sidebar},${sidebar})}`,
    `${dark}{--dsw-specific-sidebar-fill:rgba(${TINT_DARK.sidebar},${sidebar})}`,
    `${gate} body{--dsw-alias-bg-base:rgba(${TINT_LIGHT.wall},${content})}`,
    `${dark}{--dsw-alias-bg-base:rgba(${TINT_DARK.wall},${content})}`,
    `${gate} body,${gate} body *{--dsw-menu-backdrop-filter:blur(${blur}px) saturate(150%)}`
  ].join("");
}

/** Head script: arm the stylesheet before first paint, then request the native material. */
function armingScript(config) {
  const material = isActive(config) ? String(config.material) : "none";
  return `(() => {
  try {
    const desktop = window.dshDesktop;
    if (typeof desktop?.windowMaterial !== "function") {
      console.warn("dsh-plugin-glass: 未检测到已打补丁的桌面 shell，毛玻璃保持关闭（请先应用 shell 补丁）");
      document.documentElement.dataset.${GLASS_ATTRIBUTE} = "off";
      return;
    }
    document.documentElement.dataset.${GLASS_ATTRIBUTE} = ${JSON.stringify(isActive(config) ? "on" : "off")};
    desktop.windowMaterial(${JSON.stringify(material)});
  } catch (error) {
    console.warn("dsh-plugin-glass: arming failed", error);
  }
})()`;
}

/** Rows pushed into every index response. */
function glassInjections(config) {
  if (!isActive(config)) return [];
  return [
    { kind: "style", text: glassStyle(config) },
    { kind: "script", placement: "head", text: armingScript(config) }
  ];
}

/**
 * Read one configuration field without assuming the schema was applied.
 * A raw value, a schemastery Ref, a missing field, or a throwing accessor all
 * resolve to the documented default, so a schema mismatch degrades to the
 * default look instead of disabling the injection.
 */
function read(ref, fallback) {
  try {
    const value = ref !== null && typeof ref === "object" && typeof ref.get === "function" ? ref.get() : ref;
    return value === undefined || value === null ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function snapshot(config) {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    enabled: read(config?.enabled, true) !== false,
    material: pick(read(config?.material, "acrylic"), MATERIALS, "acrylic"),
    scope: pick(read(config?.scope, "sidebar"), SCOPES, "sidebar"),
    sidebarAlpha: number(read(config?.sidebarAlpha, 65), 65),
    contentAlpha: number(read(config?.contentAlpha, 35), 35),
    opaqueContent: number(read(config?.opaqueContent, 100), 100),
    blurPx: number(read(config?.blurPx, 18), 18)
  };
}

export { Config, glassInjections, glassStyle, armingScript, isActive };

/**
 * Register the settings namespace and inject the glass rows into each index.
 * @param ctx - host plugin context.
 * @param config - validated live plugin configuration.
 */
export function apply(ctx, config) {
  console.log("dsh-plugin-glass: host plugin loaded");
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  let first = true;
  ctx.on("webserver/index-inject", (table) => {
    const values = snapshot(config);
    if (first) {
      first = false;
      console.log(`dsh-plugin-glass: host ready ${JSON.stringify(values)}`);
    }
    table.push(...glassInjections(values));
  });
}
