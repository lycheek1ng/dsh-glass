// dsh-plugin-glass — client half.
//
// Adds one "毛玻璃外观" row to Settings → General and applies parameter changes to
// the live document (the host half only re-injects on the next page load).
// Everything is wrapped defensively: if any seat of the settings API differs in a
// future build, the row degrades instead of breaking the shell.
window.__ModuleLoader__.load({
  id: "dsh-plugin-glass",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var jsx = require("react/jsx-runtime").jsx;

    /**
     * The shell's own control primitives — the same components and tokens the rest of Settings uses,
     * so this row cannot drift from the product's look. Guarded: if a future build stops exporting
     * them, the row falls back to plain DOM controls instead of failing the whole module.
     */
    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      console.warn("dsh-plugin-glass: control primitives unavailable, using plain controls", error);
    }

    var ENTRY_ID = "glass-plugin";
    var MATERIALS = [
      ["acrylic", "亚克力 Acrylic"],
      ["mica", "云母 Mica"],
      ["tabbed", "标签页 Tabbed"],
      ["none", "关闭"]
    ];
    var SCOPES = [
      ["sidebar", "仅侧栏与标题栏通透（推荐）"],
      ["window", "整窗通透（含聊天区）"]
    ];

    function clamp(value, fallback) {
      var number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.max(0, Math.min(100, number)) / 100;
    }

    /** Plugin-owned stylesheet so a live parameter change needs no page reload. */
    var STYLE_ID = "dsh-plugin-glass/glass.css";
    var styleElement = null;
    function ensureStyle() {
      if (styleElement !== null && styleElement.isConnected) return styleElement;
      styleElement = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
      if (styleElement === null) {
        styleElement = document.createElement("style");
        styleElement.dataset.plugin = "dsh-plugin-glass";
        styleElement.dataset.pluginCss = STYLE_ID;
        document.head.appendChild(styleElement);
      }
      return styleElement;
    }

    /** Same sheet the host half injects for first paint; kept in one place per half. */
    function glassCss(values) {
      var sidebar = clamp(values.sidebarAlpha, 65);
      var content = clamp(values.scope === "window" ? values.contentAlpha : values.opaqueContent, 100);
      var blur = Math.max(0, Math.min(60, Number(values.blurPx) || 0));
      var gate = 'html[data-dsh-glass="on"]';
      var dark = gate + " body[data-ds-dark-theme]";
      return [
        gate + "," + gate + " body{background:transparent !important}",
        gate + " .BynINW_frame," + gate + " [data-dsh-glass-wall]{background:transparent !important}",
        // The frame's 16px content radius leaves a bare-acrylic notch in the seam; square it off.
        gate + " .BynINW_frame," + gate + " [data-dsh-glass-wall]{--dsh-windows-content-radius:0px !important}",
        gate + " .BynINW_centerCol," + gate + " [data-dsh-glass-column]{border-radius:0 !important}",
        // Windows fills the caption-button rectangle with this probe's colour, which stacks on the
        // title-bar strip (more opaque than the bar) and draws seams between the buttons.
        gate + ' body > span[style*="--dsw-specific-sidebar-fill"]{background-color:transparent !important}',
        gate + " body{--dsw-specific-sidebar-fill:rgba(249,250,251," + sidebar + ")}",
        dark + "{--dsw-specific-sidebar-fill:rgba(27,27,28," + sidebar + ")}",
        gate + " body{--dsw-alias-bg-base:rgba(255,255,255," + content + ")}",
        dark + "{--dsw-alias-bg-base:rgba(21,21,23," + content + ")}",
        gate + " body," + gate + " body *{--dsw-menu-backdrop-filter:blur(" + blur + "px) saturate(150%)}"
      ].join("");
    }

    /**
     * Chrome for the settings row itself: select triggers that follow the shell's control tokens,
     * and a track that fades from a dark frosted half to a light frosted half with no handle —
     * the row is driven by press-and-slide anywhere on the track. Injected whether or not the
     * treatment is armed, so the row keeps its look when the glass is switched off.
     */
    var CONTROL_CSS = [
      '[data-dsh-glass-select]{-webkit-appearance:none;appearance:none;height:36px;min-width:240px;padding:0 30px 0 10px;cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);',
      'background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '[data-dsh-glass-select]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-glass-select]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '[data-dsh-glass-select-wrap]{position:relative;display:inline-flex;align-items:center}',
      '[data-dsh-glass-chevron]{position:absolute;right:11px;top:50%;margin-top:-2px;width:0;height:0;pointer-events:none;',
      'border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--dsw-alias-label-tertiary)}',
      '[data-dsh-glass-field]{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-width:260px;flex:0 0 auto;',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;',
      'color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;height:36px;padding:0 10px 0 12px;cursor:pointer}',
      '[data-dsh-glass-field]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-glass-field]:disabled{cursor:not-allowed;opacity:.4}',
      '[data-dsh-glass-field-label]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-dsh-glass-field-caret]{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '[data-dsh-glass-slider-wrap]{position:relative;display:inline-flex;align-items:center;width:240px;min-width:240px;flex:0 0 auto;height:20px}',
      '[data-dsh-glass-slider-wrap][data-disabled="true"]{opacity:.5}',
      '[data-dsh-glass-slider-wrap]>input[type=range]{position:relative;z-index:2;width:100%;height:20px;margin:0;opacity:0;cursor:pointer;',
      '-webkit-appearance:none;appearance:none;background:transparent}',
      '[data-dsh-glass-slider-wrap]>input[type=range]:disabled{cursor:not-allowed}',
      '[data-dsh-glass-slider-wrap]>input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border:0;background:transparent}',
      '[data-dsh-glass-track]{position:absolute;left:0;right:0;height:20px;border-radius:999px;corner-shape:round;pointer-events:none;background:var(--dsw-alias-border-l3)}',
      '[data-dsh-glass-fill]{position:absolute;left:0;top:0;height:20px;border-radius:999px;corner-shape:round;pointer-events:none;background:var(--dsw-alias-brand-primary)}',
      '[data-dsh-glass-knob]{position:absolute;top:2px;z-index:1;width:16px;height:16px;border-radius:50%;corner-shape:round;pointer-events:none;',
      'background:var(--dsw-alias-label-primary-foreground)}',
      // Keyboard focus only: a pointer drag must not draw a ring around the track.
      '[data-dsh-glass-slider-wrap]:has(> input:focus-visible) [data-dsh-glass-track]{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}'
    ].join("");

    /**
     * Tag every full-window surface of the frame chain that still paints a background and clear
     * its fill inline. The shell's layout class names are hashed, so the sheet clears
     * `[data-dsh-glass-wall]` as well as the known frame class; walking down the largest child
     * keeps modal overlays (rendered outside that chain) from being tagged.
     */
    function tagWalls() {
      try {
        var previously = document.querySelectorAll("[data-dsh-glass-wall]");
        for (var p = 0; p < previously.length; p++) previously[p].removeAttribute("data-dsh-glass-wall");
        var previousColumns = document.querySelectorAll("[data-dsh-glass-column]");
        for (var c = 0; c < previousColumns.length; c++) previousColumns[c].removeAttribute("data-dsh-glass-column");
        var viewport = window.innerWidth * window.innerHeight;
        if (!viewport) return;
        var node = document.getElementById("root") || document.body;
        for (var depth = 0; node && depth < 12; depth++) {
          var rect = node.getBoundingClientRect();
          if (rect.width * rect.height >= viewport * 0.8) {
            var background = getComputedStyle(node).backgroundColor;
            if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
              node.setAttribute("data-dsh-glass-wall", "");
              setImportant(node, "background", "transparent");
            } else if (node.style && node.style.getPropertyValue("background")) {
              node.style.removeProperty("background");
            }
            // The frame carries the content-corner radius; without this the seam shows bare acrylic.
            node.style.setProperty("--dsh-windows-content-radius", "0px", "important");
          } else if (rect.width >= window.innerWidth * 0.4 && rect.height >= window.innerHeight * 0.7) {
            // A column beside the sidebar: square its corners so it meets the seam cleanly.
            node.setAttribute("data-dsh-glass-column", "");
            setImportant(node, "border-radius", "0");
          }
          var best = null;
          var bestArea = 0;
          for (var k = 0; k < node.children.length; k++) {
            var kid = node.children[k];
            var kidRect = kid.getBoundingClientRect();
            var area = kidRect.width * kidRect.height;
            if (area > bestArea) { bestArea = area; best = kid; }
          }
          node = best;
        }
      } catch (error) {
        /* tagging is best-effort */
      }
    }

    /** Tints for one theme; kept here because the live path needs them per theme. */
    function tints(dark) {
      return dark
        ? { sidebar: "27,27,28", base: "21,21,23" }
        : { sidebar: "249,250,251", base: "255,255,255" };
    }

    /** Inline !important always beats a same-specificity stylesheet rule, whatever order it lands in. */
    function setImportant(element, property, value) {
      element.style.setProperty(property, value, "important");
    }

    /** Variables written by earlier builds of this plugin; a stale host sheet would still read them. */
    var LEGACY_VARS = ["--dsh-glass-wall", "--dsh-glass-wall-dark", "--dsh-glass-sidebar", "--dsh-glass-sidebar-dark"];

    /** Remove every live property this plugin writes, so the shell returns to its own styling. */
    function clearLive(body) {
      body.style.removeProperty("background");
      body.style.removeProperty("--dsw-specific-sidebar-fill");
      body.style.removeProperty("--dsw-alias-bg-base");
      body.style.removeProperty("--dsw-menu-backdrop-filter");
    }

    /** Drop the inline fills from every wall tagged by an earlier pass. */
    function releaseWalls() {
      var tagged = document.querySelectorAll("[data-dsh-glass-wall]");
      for (var i = 0; i < tagged.length; i++) {
        tagged[i].style.removeProperty("background");
        tagged[i].style.removeProperty("--dsh-windows-content-radius");
        tagged[i].removeAttribute("data-dsh-glass-wall");
      }
      var columns = document.querySelectorAll("[data-dsh-glass-column]");
      for (var c = 0; c < columns.length; c++) {
        columns[c].style.removeProperty("border-radius");
        columns[c].removeAttribute("data-dsh-glass-column");
      }
    }

    /** Values the user changed from this row; the Host settings service refuses writes for a row
     * that a patch `insert` block introduced, so the renderer keeps them and replays them on load. */
    var LOCAL_KEY = "dsh-plugin-glass.settings";
    var overrides = {};
    var listeners = [];

    /**
     * The comfortable starting point that 恢复默认 restores. Keep the numbers identical to the host
     * half's Config defaults: 65% reads as clearly frosted while sidebar text stays crisp.
     */
    var DEFAULT_VALUES = {
      enabled: true,
      material: "acrylic",
      scope: "sidebar",
      sidebarAlpha: 65,
      contentAlpha: 35,
      opaqueContent: 100,
      blurPx: 18
    };

    function readOverrides() {
      try {
        var raw = window.localStorage && window.localStorage.getItem(LOCAL_KEY);
        var parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" ? parsed : {};
      } catch (error) {
        console.warn("dsh-plugin-glass: local settings unreadable", error);
        return {};
      }
    }

    function writeOverrides() {
      try {
        if (window.localStorage) window.localStorage.setItem(LOCAL_KEY, JSON.stringify(overrides));
      } catch (error) {
        console.warn("dsh-plugin-glass: local settings not persisted", error);
      }
    }

    /** Built-in defaults, then Host values, then the user's local changes. */
    function currentValues() {
      var snapshot = null;
      try { snapshot = GlassRow.form ? GlassRow.form.getSnapshot() : null; } catch (error) { /* ignore */ }
      return Object.assign({}, DEFAULT_VALUES, (snapshot && snapshot.value) || {}, overrides);
    }

    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (error) { /* ignore */ }
      }
    }

    /** Restore the comfortable defaults locally, live, and (best effort) in the Host form. */
    function restoreDefaults() {
      overrides = Object.assign({}, DEFAULT_VALUES);
      writeOverrides();
      applyLive(currentValues());
      emit();
      try {
        Object.keys(DEFAULT_VALUES).forEach(function (key) {
          var result = GlassRow.form && GlassRow.form.set(key, DEFAULT_VALUES[key]);
          if (result && typeof result.catch === "function") result.catch(function () { /* the Host may refuse */ });
        });
        document.documentElement.setAttribute("data-dsh-glass-last-write", "restore-defaults");
      } catch (error) {
        console.warn("dsh-plugin-glass: restore defaults could not reach the Host form", error);
      }
    }

    /**
     * Push every parameter onto the live document.
     *
     * The host half also injects a sheet (for first paint), and a previously loaded build of this
     * plugin may have left inline custom properties on <html>. Relying on sheet order therefore is
     * not enough: the critical properties are written inline with !important and the legacy
     * variables are removed so an older host sheet cannot resolve to a stale value.
     */
    function applyLive(values) {
      try {
        var root = document.documentElement;
        var body = document.body;
        var desktop = window.dshDesktop;
        // Without the patched shell there is no native material to see through,
        // so leaving the glass armed would only wash the window out.
        var supported = typeof desktop?.windowMaterial === "function";
        var on = supported && values.enabled !== false && values.material !== "none";
        root.setAttribute("data-dsh-glass", on ? "on" : "off");
        for (var i = 0; i < LEGACY_VARS.length; i++) root.style.removeProperty(LEGACY_VARS[i]);
        var sheet = ensureStyle();
        sheet.textContent = CONTROL_CSS + (on ? glassCss(values) : "");
        if (document.head && typeof document.head.appendChild === "function") document.head.appendChild(sheet);
        if (!on) {
          clearLive(body);
          releaseWalls();
        } else {
          var tint = tints(body.hasAttribute("data-ds-dark-theme"));
          var sidebar = clamp(values.sidebarAlpha, 65);
          var content = clamp(values.scope === "window" ? values.contentAlpha : values.opaqueContent, 100);
          var blur = Math.max(0, Math.min(60, Number(values.blurPx) || 0));
          setImportant(body, "background", "transparent");
          body.style.setProperty("--dsw-specific-sidebar-fill", "rgba(" + tint.sidebar + "," + sidebar + ")");
          body.style.setProperty("--dsw-alias-bg-base", "rgba(" + tint.base + "," + content + ")");
          body.style.setProperty("--dsw-menu-backdrop-filter", "blur(" + blur + "px) saturate(150%)");
          tagWalls();
        }
        if (supported) desktop.windowMaterial(on ? String(values.material) : "none");
      } catch (error) {
        console.warn("dsh-plugin-glass: live apply failed", error);
      }
    }

    /** Publish the settings-adoption state on the document so it can be inspected live. */
    function publishState(snapshot) {
      try {
        var root = document.documentElement;
        var value = (snapshot && snapshot.value) || {};
        root.setAttribute("data-dsh-glass-status", String((snapshot && snapshot.status) || "none"));
        root.setAttribute("data-dsh-glass-writable", String(snapshot && snapshot.writable !== undefined ? snapshot.writable : (snapshot && snapshot.status === "unavailable" ? false : "unknown")));
        root.setAttribute("data-dsh-glass-mode", String((snapshot && snapshot.mode) || "unknown"));
        root.setAttribute("data-dsh-glass-revision", String((snapshot && snapshot.revision) !== undefined ? snapshot.revision : "?"));
        root.setAttribute("data-dsh-glass-value", JSON.stringify(value));
      } catch (error) {
        /* diagnostics only */
      }
    }

    var labelStyle = {
      color: "var(--dsw-alias-label-primary)",
      fontSize: "14px",
      lineHeight: "22px",
      flex: "1 1 auto",
      minWidth: "180px"
    };
    var hintStyle = {
      color: "var(--dsw-alias-label-tertiary)",
      fontSize: "12px",
      lineHeight: "18px"
    };
    /**
     * A dropdown built from the shell's own `Menu`, so the list, its row hover fill
     * (`--dsw-alias-interactive-bg-hover`), the check mark on the current row and the keyboard walk
     * are exactly the product's. Falls back to a plain select when the primitives are missing.
     */
    function dropdown(key, options, value, disabled, onPick) {
      var state = React.useState(false);
      var open = state[0];
      var setOpen = state[1];
      var current = options.filter(function (entry) { return entry[0] === value; })[0];
      var text = current === undefined ? String(value) : current[1];
      if (primitives === null || typeof primitives.Menu !== "function") {
        return jsx("div", {
          key: key,
          "data-dsh-glass-select-wrap": "",
          style: { position: "relative", display: "inline-flex", alignItems: "center" },
          children: [
            jsx("select", {
              "data-dsh-glass-select": "",
              value: value,
              disabled: disabled,
              onChange: function (event) { onPick(event.target.value); },
              children: options.map(function (entry) {
                return jsx("option", { key: entry[0], value: entry[0], children: entry[1] });
              })
            }),
            jsx("span", { "data-dsh-glass-chevron": "" })
          ]
        });
      }
      var Caret = primitives.IconChevronDownOutlineRegular;
      var anchor = jsx("button", {
        type: "button",
        "data-dsh-glass-field": "",
        disabled: disabled,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: function () { setOpen(!open); },
        children: [
          jsx("span", { "data-dsh-glass-field-label": "", children: text }),
          jsx("span", { "data-dsh-glass-field-caret": "", children: Caret === undefined ? null : jsx(Caret, {}) })
        ]
      });
      return jsx(primitives.Menu, {
        key: key,
        open: open,
        anchor: anchor,
        items: options.map(function (entry) { return { id: entry[0], label: entry[1] }; }),
        selectedId: value,
        selection: "check",
        align: "start",
        side: "bottom",
        portal: true,
        onSelect: function (id) { onPick(id); setOpen(false); },
        onClose: function () { setOpen(false); }
      });
    }

    function line(key, label, hint, control) {
      return jsx("div", {
        key: key,
        style: { display: "flex", alignItems: "center", gap: "12px", padding: "8px 0", flexWrap: "wrap" },
        children: [
          jsx("div", { style: { flex: "1 1 auto", minWidth: "180px" }, children: [
            jsx("div", { style: labelStyle, children: label }),
            hint ? jsx("div", { style: hintStyle, children: hint }) : null
          ] }),
          control
        ]
      });
    }

    /**
     * The shell ships no slider primitive, so this one is modelled on `Switch`: the same 20px
     * capsule (`--dsw-alias-border-l3`), a brand-coloured fill, a 16px circular thumb
     * (`--dsw-alias-label-primary-foreground`) and the shared focus ring. Dragging anywhere on the
     * track works, and the numeric value is printed in the row label.
     */
    function slider(key, value, onChange, min, max, disabled) {
      var low = min === undefined ? 0 : min;
      var high = max === undefined ? 100 : max;
      var ratio = high === low ? 0 : (Number(value) - low) / (high - low);
      var percent = Math.max(0, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100));
      // The knob keeps a 2px inset on every side, exactly like the Switch thumb inside its capsule,
      // and the filled capsule always reaches past the knob so the knob rides *inside* it instead of
      // perching on the fill boundary.
      var travel = "calc(2px + (100% - 20px) * " + (percent / 100) + ")";
      var filled = "calc(20px + (100% - 20px) * " + (percent / 100) + ")";
      return jsx("div", {
        key: key,
        "data-dsh-glass-slider-wrap": "",
        "data-disabled": disabled ? "true" : "false",
        style: { position: "relative", display: "inline-flex", alignItems: "center", width: "240px", height: "20px" },
        children: [
          jsx("div", { "data-dsh-glass-track": "" }),
          jsx("div", { "data-dsh-glass-fill": "", style: { width: filled } }),
          jsx("div", { "data-dsh-glass-knob": "", style: { left: travel } }),
          jsx("input", {
            type: "range",
            min: low,
            max: high,
            step: 1,
            value: value,
            disabled: disabled,
            onChange: function (event) { onChange(Number(event.target.value)); },
            style: {
              position: "relative",
              zIndex: 2,
              width: "100%",
              height: "20px",
              margin: 0,
              opacity: 0,
              cursor: disabled ? "not-allowed" : "pointer",
              background: "transparent",
              WebkitAppearance: "none",
              appearance: "none"
            }
          })
        ]
      });
    }

    /** Native two-state toggle (`Switch`), with a checkbox fallback. */
    function toggle(label, checked, disabled, onChange) {
      if (primitives !== null && typeof primitives.Switch === "function") {
        return jsx(primitives.Switch, { label: label, checked: checked, disabled: disabled, onChange: onChange });
      }
      return jsx("input", {
        type: "checkbox",
        "aria-label": label,
        checked: checked,
        disabled: disabled,
        onChange: function (event) { onChange(event.target.checked); },
        style: { width: "18px", height: "18px", accentColor: "var(--dsw-alias-state-business-primary)" }
      });
    }

    /** Native action button (`Button`), with a plain fallback. */
    function action(label, onClick, disabled) {
      if (primitives !== null && typeof primitives.Button === "function") {
        return jsx(primitives.Button, { variant: "outline", onClick: onClick, disabled: disabled, children: label });
      }
      return jsx("button", {
        type: "button",
        onClick: onClick,
        disabled: disabled,
        style: {
          background: "transparent",
          color: "var(--dsw-alias-label-primary)",
          border: "0.5px solid var(--dsw-alias-border-l3)",
          borderRadius: "var(--dsw-radius-md)",
          padding: "0 14px",
          height: "36px",
          fontSize: "14px",
          cursor: "pointer"
        },
        children: label
      });
    }

    /**
     * The settings row. It reads its own configuration snapshot instead of relying on
     * a store seat, which keeps it independent of that seat's exact contract.
     */
    function GlassRow() {
      var form = GlassRow.form;
      var state = React.useState(function () {
        try { return form.getSnapshot(); } catch (error) { return null; }
      });
      var snap = state[0];
      var setSnap = state[1];

      var tick = React.useState(0);
      var setTick = tick[1];

      React.useEffect(function () {
        if (form === undefined) return undefined;
        var active = true;
        var unsubscribe = form.subscribe(function () {
          if (active) setSnap(form.getSnapshot());
        });
        var listener = function () { if (active) setTick(function (n) { return n + 1; }); };
        listeners.push(listener);
        return function () {
          active = false;
          listeners = listeners.filter(function (item) { return item !== listener; });
          if (typeof unsubscribe === "function") unsubscribe();
        };
      }, []);

      var value = currentValues();
      var writable = !snap || snap.status !== "unavailable";
      /**
       * Store the change where it is certain to survive a restart, then apply it live and finally
       * offer it to the Host settings form. A row introduced by a patch `insert` block is refused
       * by the settings service (it rewrites top-level id-targeted configs only), so the local
       * copy is the source of truth while the Host write stays a best-effort upgrade.
       */
      var set = function (key, next) {
        try {
          overrides[key] = next;
          writeOverrides();
          applyLive(currentValues());
          emit();
          var result = form.set(key, next);
          if (result && typeof result.then === "function") {
            result.then(function () {
              document.documentElement.setAttribute("data-dsh-glass-last-write", key + "=" + next + " accepted");
            }, function (error) {
              document.documentElement.setAttribute("data-dsh-glass-last-write", key + "=" + next + " refused " + String(error));
            });
          }
        } catch (error) {
          console.warn("dsh-plugin-glass: write failed", error);
          document.documentElement.setAttribute("data-dsh-glass-last-write", key + "=" + next + " threw " + String(error));
        }
      };

      /** Current or default value of one parameter, for labels and control positions. */
      var current = function (key) {
        return value[key] === undefined || value[key] === null ? DEFAULT_VALUES[key] : value[key];
      };

      var controls = [
        line("material", "窗口材质", "由 Windows 系统绘制的背景材质",
          dropdown("material", MATERIALS, value.material || "acrylic", !writable, function (id) { set("material", id); })),
        line("scope", "通透范围", "只让侧栏透出桌面，正文区保持不透明，读起来最省力",
          dropdown("scope", SCOPES, value.scope || "sidebar", !writable, function (id) { set("scope", id); })),
        line("sidebarAlpha", "侧栏不透明度", "数值越小越透出桌面（默认 " + DEFAULT_VALUES.sidebarAlpha + "%，当前 " + current("sidebarAlpha") + "%）",
          slider("sidebarAlpha", current("sidebarAlpha"), function (next) { set("sidebarAlpha", next); }, 0, 100, !writable)),
        line("contentAlpha", "内容区不透明度（整窗模式）", "仅“整窗通透”生效（默认 " + DEFAULT_VALUES.contentAlpha + "%，当前 " + current("contentAlpha") + "%）",
          slider("contentAlpha", current("contentAlpha"), function (next) { set("contentAlpha", next); }, 0, 100, !writable)),
        line("opaqueContent", "内容区不透明度（仅侧栏模式）", "100% = 正文完全不透明（最清晰），调低可让正文也透出（当前 " + current("opaqueContent") + "%）",
          slider("opaqueContent", current("opaqueContent"), function (next) { set("opaqueContent", next); }, 0, 100, !writable)),
        line("blurPx", "菜单与浮层模糊", "单位 px（默认 " + DEFAULT_VALUES.blurPx + "px，当前 " + current("blurPx") + "px）",
          slider("blurPx", current("blurPx"), function (next) { set("blurPx", next); }, 0, 60, !writable)),
        line("enabled", "启用毛玻璃", "关闭后立即恢复原始不透明外观",
          toggle("启用毛玻璃", value.enabled !== false, !writable, function (next) { set("enabled", next); })),
        line("restore", "恢复默认", "把上面所有参数恢复到最舒服的一组（侧栏 " + DEFAULT_VALUES.sidebarAlpha + "%）",
          action("恢复默认", function () { restoreDefaults(); }, !writable))
      ];

      return jsx("div", {
        "data-dsh-glass-row": "settings",
        style: { borderBottom: "0.5px solid var(--dsw-alias-border-l2)", padding: "16px 0", display: "flex", flexDirection: "column" },
        children: [
          jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "22px", fontWeight: 500 }, children: "毛玻璃外观" }),
          jsx("div", {
            style: hintStyle,
            children: !writable
              ? "当前页面无法读取设置，控件已禁用"
              : (typeof window.dshDesktop?.windowMaterial === "function"
                ? null
                : "未检测到已打补丁的桌面 shell：请先应用补丁，毛玻璃暂不生效")
          })
        ].concat(controls)
      });
    }

    var inject = ["slots", "configForms"];

    function apply(ctx) {
      var form;
      try {
        form = ctx.configForms.get(ENTRY_ID);
      } catch (error) {
        console.warn("dsh-plugin-glass: settings form unavailable", error);
        return;
      }
      GlassRow.form = form;
      // Replay whatever the user changed here in an earlier session before the first apply.
      overrides = readOverrides();
      // Adopt the durable values on load so the document matches the stored settings.
      ctx.effect(function () {
        var adopt = function () {
          var snapshot = null;
          try { snapshot = form.getSnapshot(); } catch (error) { console.warn("dsh-plugin-glass: snapshot failed", error); }
          publishState(snapshot);
          try { applyLive(currentValues()); } catch (error) { /* ignore */ }
        };
        adopt();
        var unsubscribe = form.subscribe(adopt);
        // The shell's frame re-renders (sidebar collapse, resize), so keep the runtime
        // wall tags fresh while the glass is armed.
        var keepTagged = function () {
          if (document.documentElement.getAttribute("data-dsh-glass") === "on") tagWalls();
        };
        window.addEventListener("resize", keepTagged);
        var timer = window.setInterval(keepTagged, 3000);
        return function () {
          if (typeof unsubscribe === "function") unsubscribe();
          window.removeEventListener("resize", keepTagged);
          window.clearInterval(timer);
        };
      }, "glass: adopt settings");

      try {
        ctx.slots.inject("settings.general.item", function (scope) {
          var registrar = scope && typeof scope.register === "function" ? scope : ctx.slots;
          return registrar.register({
            name: "settings.general.item",
            id: "glass",
            order: 30
          }, GlassRow);
        });
      } catch (error) {
        console.warn("dsh-plugin-glass: settings row unavailable", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
