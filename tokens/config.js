import StyleDictionary from 'style-dictionary';

// Custom transform: read lightValue from token original
// Tokens use { "value": "dark-default", "lightValue": "light-override" } format
StyleDictionary.registerTransform({
  name: 'semantic/dark-light',
  type: 'value',
  transitive: true,
  transform: (token) => {
    if (token.original?.lightValue !== undefined) {
      token.lightValue = token.original.lightValue;
    }
    return token.value;
  },
});

// Custom format: generate :root (dark defaults) + html:not(.dark) (light overrides)
StyleDictionary.registerFormat({
  name: 'css/variables-themed',
  format: ({ dictionary }) => {
    const rootVars = [];
    const lightVars = [];

    dictionary.allTokens.forEach((token) => {
      const name = `--zephyr-${token.path.join('-')}`;
      const darkVal = token.value;
      const lightVal = token.lightValue ?? token.value;

      rootVars.push(`  ${name}: ${darkVal};`);
      if (lightVal !== darkVal) {
        lightVars.push(`  ${name}: ${lightVal};`);
      }
    });

    let output = ':root {\n' + rootVars.join('\n') + '\n}\n';
    if (lightVars.length) {
      output += '\nhtml:not(.dark) {\n' + lightVars.join('\n') + '\n}\n';
    }
    return output;
  },
});

// Custom format: generate body.theme-* accent variables
StyleDictionary.registerFormat({
  name: 'css/theme-vars',
  format: () => {
    const themes = {
      blue:   { primary: '#007AFF', rgb: '0, 122, 255' },
      green:  { primary: '#34C759', rgb: '52, 199, 89' },
      orange: { primary: '#FF9500', rgb: '255, 149, 0' },
      pink:   { primary: '#FF2D55', rgb: '255, 45, 85' },
      purple: { primary: '#AF52DE', rgb: '175, 82, 222' },
    };

    const lines = [];
    for (const [name, t] of Object.entries(themes)) {
      lines.push(
        `html.theme-${name} { --accent-primary: ${t.primary}; --accent-glow: rgba(${t.rgb}, 0.2); --accent-rgb: ${t.rgb}; }`,
      );
    }
    return lines.join('\n') + '\n';
  },
});

// ── Compose Kotlin format (path-based grouping, no type dependency) ───────

StyleDictionary.registerFormat({
  name: 'custom/compose-kotlin',
  format: ({ dictionary }) => {
    const toCamel = (str) => str.replace(/[-_. ](.)/g, (_, c) => c.toUpperCase());
    const toCompose = (val) => {
      // Handle rgba() → Color(r, g, b, a)
      const rgbaMatch = val.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
      if (rgbaMatch) {
        const [, r, g, b, a] = rgbaMatch;
        return `Color(${(r/255).toFixed(3)}f, ${(g/255).toFixed(3)}f, ${(b/255).toFixed(3)}f, ${a}f)`;
      }
      // Handle hsla() → parse as CSS, fallback to hex approximation
      if (val.startsWith('hsla(')) {
        // Extract h, s%, l%, a
        const m = val.match(/^hsla\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)\s*\)$/);
        if (m) {
          const [, h, s, l, a] = m.map(Number);
          // HSL to RGB
          const c = (1 - Math.abs(2 * l / 100 - 1)) * s / 100;
          const x = c * (1 - Math.abs((h / 60) % 2 - 1));
          const m1 = l / 100 - c / 2;
          let r1, g1, b1;
          if (h < 60) { r1 = c; g1 = x; b1 = 0; }
          else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
          else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
          else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
          else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
          else { r1 = c; g1 = 0; b1 = x; }
          return `Color(${(r1+m1).toFixed(3)}f, ${(g1+m1).toFixed(3)}f, ${(b1+m1).toFixed(3)}f, ${a}f)`;
        }
      }
      // Handle #hex → Color(0xFF...)
      const hex = val.replace('#', '');
      if (/^[0-9a-fA-F]{3,8}$/.test(hex)) {
        return `Color(0xFF${hex.toUpperCase().padEnd(8, 'FF').slice(0,8)})`;
      }
      // Fallback: var() references or complex values — skip
      return null;
    };

    // ── CSS shadow parser ──────────────────────────────────────────────
    // Parses a single CSS box-shadow value (no inset, no multi-shadow)
    // e.g. "0 4px 20px rgba(0,0,0,0.2)" → { x, y, blur, spread, color }
    // e.g. "10px 10px 10px 0 rgba(0,0,0,0.1)" → { x:10, y:10, blur:10, spread:0, color }
    // e.g. "0 24px 48px -12px rgba(0,0,0,0.5)" → { x:0, y:24, blur:48, spread:-12, color }
    const parseCssShadow = (val) => {
      if (!val || val.includes('inset')) return null; // skip inset
      // Check for comma-separated multi-shadow (commas outside rgba())
      // Remove rgba(...) blocks first, then check for commas
      const stripped = val.replace(/rgba\([^)]+\)/g, '').replace(/#[0-9a-fA-F]+/g, '');
      if (stripped.includes(',')) return null; // multi-shadow
      // Extract color first (rgba(...) or #hex at end)
      const colorMatch = val.match(/(rgba\([^)]+\)|#[0-9a-fA-F]+)\s*$/);
      if (!colorMatch) return null;
      const color = colorMatch[1];
      const numsStr = val.slice(0, colorMatch.index).trim();
      // Parse numeric values (with optional px suffix)
      const nums = numsStr.split(/\s+/).map(s => parseFloat(s));
      if (nums.length < 3 || nums.some(isNaN)) return null;
      return {
        x: nums[0],
        y: nums[1],
        blur: nums[2],
        spread: nums.length >= 4 ? nums[3] : 0,
        color,
      };
    };

    // Convert CSS color string to Compose Color constructor args
    const shadowColorToCompose = (colorStr) => {
      const rgbaMatch = colorStr.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
      if (rgbaMatch) {
        const [, r, g, b, a] = rgbaMatch;
        return `Color(${(r/255).toFixed(3)}f, ${(g/255).toFixed(3)}f, ${(b/255).toFixed(3)}f, ${a}f)`;
      }
      const composeVal = toCompose(colorStr);
      return composeVal;
    };

    // ── CSS time parser ────────────────────────────────────────────────
    const parseCssTime = (val) => {
      const m = val.match(/^([\d.]+)(ms|s)$/);
      if (m) {
        const num = parseFloat(m[1]);
        return m[2] === 's' ? Math.round(num * 1000) : Math.round(num);
      }
      return null;
    };

    // ── CSS easing parser ──────────────────────────────────────────────
    const parseCssEasing = (val) => {
      const m = val.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
      if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
      if (val === 'ease-in') return [0.42, 0, 1, 1];
      if (val === 'ease-out') return [0, 0, 0.58, 1];
      if (val === 'ease') return [0.25, 0.1, 0.25, 1];
      if (val === 'linear') return [0, 0, 1, 1];
      return null;
    };

    // ── Group tokens by top-level path segment ─────────────────────────
    const colorPaths = ['text', 'bg', 'border', 'color', 'accent'];
    const spacingPaths = ['spacing', 'space'];
    const radiusPaths = ['radius', 'borderRadius', 'corner'];
    const fontSizePaths = ['fontSize', 'font-size', 'typography'];
    const shadowPaths = ['shadow'];
    const timePaths = ['time'];
    const easingPaths = ['easing'];
    const zIndexPaths = ['z-index', 'zIndex'];
    const glassPaths = ['glass'];
    const brightnessPaths = ['brightness'];
    const componentPaths = ['button', 'input', 'card', 'badge', 'dropdown', 'switch', 'modal', 'panel'];

    const colorTokens = [];
    const spacingTokens = [];
    const radiusTokens = [];
    const fontSizeTokens = [];
    const shadowTokens = [];
    const timeTokens = [];
    const easingTokens = [];
    const zIndexTokens = [];
    const glassTokens = [];
    const brightnessTokens = [];
    const componentTokens = {}; // keyed by component name

    dictionary.allTokens.forEach((token) => {
      const topPath = token.path[0];
      const name = toCamel(token.name);
      const value = token.value;

      if (colorPaths.includes(topPath)) {
        const composeVal = toCompose(value);
        if (composeVal) {
          const lightCompose = token.lightValue ? toCompose(token.lightValue) : null;
          colorTokens.push({ name, darkVal: composeVal, lightVal: lightCompose });
        }
      } else if (spacingPaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) spacingTokens.push({ name, value: `${numVal}.dp` });
      } else if (radiusPaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) radiusTokens.push({ name, value: `${numVal}.dp` });
      } else if (fontSizePaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) fontSizeTokens.push({ name, value: `${numVal}.sp` });
      } else if (shadowPaths.includes(topPath)) {
        const parsed = parseCssShadow(value);
        if (parsed) {
          const composeColor = shadowColorToCompose(parsed.color);
          const lightParsed = token.lightValue ? parseCssShadow(token.lightValue) : null;
          const lightComposeColor = lightParsed ? shadowColorToCompose(lightParsed.color) : null;
          shadowTokens.push({
            name,
            x: parsed.x,
            y: parsed.y,
            blur: parsed.blur,
            spread: parsed.spread,
            color: composeColor,
            lightX: lightParsed ? lightParsed.x : null,
            lightY: lightParsed ? lightParsed.y : null,
            lightBlur: lightParsed ? lightParsed.blur : null,
            lightSpread: lightParsed ? lightParsed.spread : null,
            lightColor: lightComposeColor,
          });
        } else {
          // Cannot parse — output as comment
          shadowTokens.push({ name, raw: value, lightRaw: token.lightValue || null });
        }
      } else if (timePaths.includes(topPath)) {
        const ms = parseCssTime(value);
        if (ms !== null) timeTokens.push({ name, value: ms });
      } else if (easingPaths.includes(topPath)) {
        const bezier = parseCssEasing(value);
        if (bezier) easingTokens.push({ name, value: bezier });
      } else if (zIndexPaths.includes(topPath)) {
        const numVal = parseInt(value, 10);
        if (!isNaN(numVal)) zIndexTokens.push({ name, value: numVal });
      } else if (glassPaths.includes(topPath)) {
        const blurMatch = value.match(/blur\(([\d.]+)px\)/);
        if (blurMatch) glassTokens.push({ name, value: parseFloat(blurMatch[1]) });
      } else if (brightnessPaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) brightnessTokens.push({ name, value: numVal });
      } else if (componentPaths.includes(topPath)) {
        const compName = topPath;
        if (!componentTokens[compName]) componentTokens[compName] = [];
        const propName = token.path.slice(1).map(toCamel).join('');
        const trimmed = value.trim();
        // Font-size: rem/px → sp
        if (propName === 'fontSize' || propName.toLowerCase().includes('fontsize')) {
          const remMatch = trimmed.match(/^([\d.]+)rem$/);
          const pxMatch = trimmed.match(/^([\d.]+)px$/);
          if (remMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: `${parseFloat(remMatch[1]) * 16}.sp` });
          } else if (pxMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: `${parseFloat(pxMatch[1])}.sp` });
          } else {
            const numVal = parseFloat(trimmed);
            if (!isNaN(numVal)) componentTokens[compName].push({ name: toCamel(propName), value: `${numVal}.sp` });
            else componentTokens[compName].push({ name: toCamel(propName), raw: value });
          }
        // Font-weight: pure number
        } else if (propName === 'weight') {
          const numVal = parseFloat(trimmed);
          if (!isNaN(numVal)) componentTokens[compName].push({ name: toCamel(propName), value: `FontWeight.W${Math.round(numVal)}` });
          else componentTokens[compName].push({ name: toCamel(propName), raw: value });
        // Letter-spacing / tracking: em → sp
        } else if (propName === 'tracking') {
          const emMatch = trimmed.match(/^([\d.]+)em$/);
          if (emMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: `${parseFloat(emMatch[1])}.sp` });
          } else {
            componentTokens[compName].push({ name: toCamel(propName), raw: value });
          }
        // Size-like props (radius, width, height, gap, padding*, item*): px/rem → dp
        } else if (/^(radius|width|height|gap|padding|item)/.test(propName)) {
          const remMatch = trimmed.match(/^([\d.]+)rem$/);
          const pxMatch = trimmed.match(/^([\d.]+)px$/);
          // Multi-value like "16px 8px" or "0.125rem 0.375rem" — output as comment
          if (/\s+/.test(trimmed)) {
            componentTokens[compName].push({ name: toCamel(propName), raw: value });
          } else if (remMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: `${parseFloat(remMatch[1]) * 16}.dp` });
          } else if (pxMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: `${parseFloat(pxMatch[1])}.dp` });
          } else {
            const numVal = parseFloat(trimmed);
            if (!isNaN(numVal)) componentTokens[compName].push({ name: toCamel(propName), value: `${numVal}.dp` });
            else componentTokens[compName].push({ name: toCamel(propName), raw: value });
          }
        // Text-transform and other non-numeric values
        } else {
          componentTokens[compName].push({ name: toCamel(propName), raw: value });
        }
      }
    });

    // ── Build output lines ─────────────────────────────────────────────
    const colorLines = colorTokens.map(t => {
      let line = `    val ${t.name}: Color = ${t.darkVal}`;
      if (t.lightVal) line += `\n    val ${t.name}Light: Color = ${t.lightVal}`;
      return line;
    }).join('\n');

    const spacingLines = spacingTokens.map(t => `    val ${t.name} = ${t.value}`).join('\n');
    const radiusLines = radiusTokens.map(t => `    val ${t.name} = ${t.value}`).join('\n');
    const fontSizeLines = fontSizeTokens.map(t => `    val ${t.name} = ${t.value}`).join('\n');

    // Shadow output
    const shadowLines = shadowTokens.map(t => {
      if (t.raw) {
        let line = `    // ${t.raw}`;
        if (t.lightRaw) line += ` (light: ${t.lightRaw})`;
        return line;
      }
      let line = `    val ${t.name} = ShadowData(offsetX = ${t.x}.dp, offsetY = ${t.y}.dp, blurRadius = ${t.blur}.dp, spread = ${t.spread}.dp, color = ${t.color})`;
      if (t.lightColor) {
        line += `\n    val ${t.name}Light = ShadowData(offsetX = ${(t.lightX !== null ? t.lightX : t.x)}.dp, offsetY = ${(t.lightY !== null ? t.lightY : t.y)}.dp, blurRadius = ${(t.lightBlur !== null ? t.lightBlur : t.blur)}.dp, spread = ${(t.lightSpread !== null ? t.lightSpread : t.spread)}.dp, color = ${t.lightColor})`;
      }
      return line;
    }).join('\n');

    // Time output
    const timeLines = timeTokens.map(t => `    val ${t.name} = ${t.value}  // ms`).join('\n');

    // Easing output
    const easingLines = easingTokens.map(t =>
      `    val ${t.name} = androidx.compose.animation.core.CubicBezierEasing(${t.value[0]}f, ${t.value[1]}f, ${t.value[2]}f, ${t.value[3]}f)`
    ).join('\n');

    // Z-index output
    const zIndexLines = zIndexTokens.map(t => `    val ${t.name} = ${t.value}`).join('\n');

    // Glass output
    const glassLines = glassTokens.map(t => `    val ${t.name} = ${t.value}.dp`).join('\n');

    // Brightness output
    const brightnessLines = brightnessTokens.map(t => `    val ${t.name} = ${t.value}f`).join('\n');

    // Component output
    const componentObjects = Object.entries(componentTokens).map(([compName, props]) => {
      const objName = `App${compName.charAt(0).toUpperCase() + compName.slice(1)}`;
      const propLines = props.map(p => {
        if (p.raw) return `    // ${p.name}: ${p.raw}`;
        return `    val ${p.name} = ${p.value}`;
      }).join('\n');
      return `object ${objName} {\n${propLines}\n}`;
    }).join('\n\n');

    // Accent theme output (hardcoded)
    const accentBlock = `object AppAccent {
    data class AccentTheme(val primary: Color, val glow: Color, val rgb: String)
    val blue = AccentTheme(Color(0xFF007AFF), Color(0x33007AFF), "0, 122, 255")
    val green = AccentTheme(Color(0xFF34C759), Color(0x3334C759), "52, 199, 89")
    val orange = AccentTheme(Color(0xFFFF9500), Color(0x33FF9500), "255, 149, 0")
    val pink = AccentTheme(Color(0xFFFF2D55), Color(0x33FF2D55), "255, 45, 85")
    val purple = AccentTheme(Color(0xFFAF52DE), Color(0x33AF52DE), "175, 82, 222")
}`;

    return `package com.zephyr.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.geometry.Offset

// AUTO-GENERATED — DO NOT EDIT — Source: tokens/src/*.json
// Run: npx style-dictionary build --config=tokens/config.js

object AppColors {
${colorLines}
}

object AppSpacing {
${spacingLines}
}

object AppRadius {
${radiusLines}
}

object AppFontSize {
${fontSizeLines}
}

data class ShadowData(val offsetX: Dp, val offsetY: Dp, val blurRadius: Dp, val spread: Dp = 0.dp, val color: Color)

object AppShadow {
${shadowLines}
}

object AppTime {
${timeLines}
}

object AppEasing {
${easingLines}
}

object AppZIndex {
${zIndexLines}
}

object AppGlass {
${glassLines}
}

object AppBrightness {
${brightnessLines}
}

${componentObjects}

${accentBlock}
`;
  }
});

// ── Swift Constants format (full parity with Compose Kotlin) ─────────────

StyleDictionary.registerFormat({
  name: 'custom/swift-constants',
  format: ({ dictionary }) => {
    const toCamel = (str) => str.replace(/[-_. ](.)/g, (_, c) => c.toUpperCase());

    // ── Color converters ──────────────────────────────────────────────
    const hexToSwift = (hex) => {
      const h = hex.replace('#','');
      // Support 3-char hex (#fff → fff → ffffff)
      const expanded = h.length === 3
        ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2]
        : h;
      const r = (parseInt(expanded.slice(0,2),16)/255).toFixed(3);
      const g = (parseInt(expanded.slice(2,4),16)/255).toFixed(3);
      const b = (parseInt(expanded.slice(4,6),16)/255).toFixed(3);
      const a = expanded.length === 8 ? (parseInt(expanded.slice(6,8),16)/255).toFixed(3) : null;
      return a
        ? `Color(red: ${r}, green: ${g}, blue: ${b}, opacity: ${a})`
        : `Color(red: ${r}, green: ${g}, blue: ${b})`;
    };

    const rgbaToSwift = (val) => {
      const m = val.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
      if (m) {
        const [, r, g, b, a] = m;
        return `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}, opacity: ${a})`;
      }
      if (val.startsWith('#')) return hexToSwift(val);
      return null;
    };

    const hslaToSwift = (val) => {
      const m = val.match(/^hsla\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)\s*\)$/);
      if (m) {
        const [, h, s, l, a] = m.map(Number);
        // HSL to RGB conversion
        const c = (1 - Math.abs(2 * l / 100 - 1)) * s / 100;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m1 = l / 100 - c / 2;
        let r1, g1, b1;
        if (h < 60) { r1 = c; g1 = x; b1 = 0; }
        else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
        else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
        else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
        else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
        else { r1 = c; g1 = 0; b1 = x; }
        return `Color(red: ${(r1+m1).toFixed(3)}, green: ${(g1+m1).toFixed(3)}, blue: ${(b1+m1).toFixed(3)}, opacity: ${a})`;
      }
      return null;
    };

    const toSwiftColor = (val) => {
      if (val.startsWith('hsla(')) return hslaToSwift(val);
      return rgbaToSwift(val);
    };

    // ── CSS shadow parser (same as Compose) ───────────────────────────
    const parseCssShadow = (val) => {
      if (!val || val.includes('inset')) return null;
      const stripped = val.replace(/rgba\([^)]+\)/g, '').replace(/#[0-9a-fA-F]+/g, '');
      if (stripped.includes(',')) return null;
      const colorMatch = val.match(/(rgba\([^)]+\)|#[0-9a-fA-F]+)\s*$/);
      if (!colorMatch) return null;
      const color = colorMatch[1];
      const numsStr = val.slice(0, colorMatch.index).trim();
      const nums = numsStr.split(/\s+/).map(s => parseFloat(s));
      if (nums.length < 3 || nums.some(isNaN)) return null;
      return {
        x: nums[0], y: nums[1], blur: nums[2],
        spread: nums.length >= 4 ? nums[3] : 0,
        color,
      };
    };

    const shadowColorToSwift = (colorStr) => {
      return toSwiftColor(colorStr);
    };

    // ── CSS time parser ───────────────────────────────────────────────
    const parseCssTime = (val) => {
      const m = val.match(/^([\d.]+)(ms|s)$/);
      if (m) {
        const num = parseFloat(m[1]);
        return m[2] === 's' ? Math.round(num * 1000) : Math.round(num);
      }
      return null;
    };

    // ── CSS easing parser ─────────────────────────────────────────────
    const parseCssEasing = (val) => {
      const m = val.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
      if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
      if (val === 'ease-in') return [0.42, 0, 1, 1];
      if (val === 'ease-out') return [0, 0, 0.58, 1];
      if (val === 'ease') return [0.25, 0.1, 0.25, 1];
      if (val === 'linear') return [0, 0, 1, 1];
      return null;
    };

    // ── Group tokens by top-level path segment ─────────────────────────
    const colorPaths = ['text', 'bg', 'border', 'color', 'accent'];
    const spacingPaths = ['spacing', 'space'];
    const radiusPaths = ['radius', 'borderRadius', 'corner'];
    const fontSizePaths = ['fontSize', 'font-size', 'typography'];
    const shadowPaths = ['shadow'];
    const timePaths = ['time'];
    const easingPaths = ['easing'];
    const zIndexPaths = ['z-index', 'zIndex'];
    const glassPaths = ['glass'];
    const brightnessPaths = ['brightness'];
    const componentPaths = ['button', 'input', 'card', 'badge', 'dropdown', 'switch', 'modal', 'panel'];

    const colorTokens = [];
    const spacingTokens = [];
    const radiusTokens = [];
    const fontSizeTokens = [];
    const shadowTokens = [];
    const timeTokens = [];
    const easingTokens = [];
    const zIndexTokens = [];
    const glassTokens = [];
    const brightnessTokens = [];
    const componentTokens = {};

    dictionary.allTokens.forEach((token) => {
      const topPath = token.path[0];
      const name = toCamel(token.name);
      const value = token.value;

      if (colorPaths.includes(topPath)) {
        const swiftVal = toSwiftColor(value);
        if (swiftVal) {
          const lightSwift = token.lightValue ? toSwiftColor(token.lightValue) : null;
          colorTokens.push({ name, darkVal: swiftVal, lightVal: lightSwift });
        }
      } else if (spacingPaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) spacingTokens.push({ name, value: numVal });
      } else if (radiusPaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) radiusTokens.push({ name, value: numVal });
      } else if (fontSizePaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) fontSizeTokens.push({ name, value: numVal });
      } else if (shadowPaths.includes(topPath)) {
        const parsed = parseCssShadow(value);
        if (parsed) {
          const swiftColor = shadowColorToSwift(parsed.color);
          const lightParsed = token.lightValue ? parseCssShadow(token.lightValue) : null;
          const lightSwiftColor = lightParsed ? shadowColorToSwift(lightParsed.color) : null;
          shadowTokens.push({
            name,
            x: parsed.x, y: parsed.y, blur: parsed.blur, spread: parsed.spread,
            color: swiftColor,
            lightX: lightParsed?.x, lightY: lightParsed?.y,
            lightBlur: lightParsed?.blur, lightSpread: lightParsed?.spread,
            lightColor: lightSwiftColor,
          });
        } else {
          shadowTokens.push({ name, raw: value, lightRaw: token.lightValue || null });
        }
      } else if (timePaths.includes(topPath)) {
        const ms = parseCssTime(value);
        if (ms !== null) timeTokens.push({ name, value: ms });
      } else if (easingPaths.includes(topPath)) {
        const bezier = parseCssEasing(value);
        if (bezier) easingTokens.push({ name, value: bezier });
      } else if (zIndexPaths.includes(topPath)) {
        const numVal = parseInt(value, 10);
        if (!isNaN(numVal)) zIndexTokens.push({ name, value: numVal });
      } else if (glassPaths.includes(topPath)) {
        const blurMatch = value.match(/blur\(([\d.]+)px\)/);
        if (blurMatch) glassTokens.push({ name, value: parseFloat(blurMatch[1]) });
      } else if (brightnessPaths.includes(topPath)) {
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) brightnessTokens.push({ name, value: numVal });
      } else if (componentPaths.includes(topPath)) {
        const compName = topPath;
        if (!componentTokens[compName]) componentTokens[compName] = [];
        const propName = token.path.slice(1).map(toCamel).join('');
        const trimmed = value.trim();
        // Font-size: rem/px → CGFloat (pt)
        if (propName === 'fontSize' || propName.toLowerCase().includes('fontsize')) {
          const remMatch = trimmed.match(/^([\d.]+)rem$/);
          const pxMatch = trimmed.match(/^([\d.]+)px$/);
          if (remMatch) componentTokens[compName].push({ name: toCamel(propName), value: parseFloat(remMatch[1]) * 16 });
          else if (pxMatch) componentTokens[compName].push({ name: toCamel(propName), value: parseFloat(pxMatch[1]) });
          else { const n = parseFloat(trimmed); if (!isNaN(n)) componentTokens[compName].push({ name: toCamel(propName), value: n }); else componentTokens[compName].push({ name: toCamel(propName), raw: value }); }
        // Font-weight: pure number
        } else if (propName === 'weight') {
          const n = parseFloat(trimmed);
          if (!isNaN(n)) componentTokens[compName].push({ name: toCamel(propName), value: `Font.Weight.${n >= 700 ? 'bold' : n >= 600 ? 'semibold' : n >= 500 ? 'medium' : 'regular'}` });
          else componentTokens[compName].push({ name: toCamel(propName), raw: value });
        // Letter-spacing / tracking: em → CGFloat
        } else if (propName === 'tracking') {
          const emMatch = trimmed.match(/^([\d.]+)em$/);
          if (emMatch) componentTokens[compName].push({ name: toCamel(propName), value: parseFloat(emMatch[1]) * 16 });
          else componentTokens[compName].push({ name: toCamel(propName), raw: value });
        // Size-like props (radius, width, height, gap, padding*): px/rem → CGFloat (pt)
        } else if (/^(radius|width|height|gap|padding|item)/.test(propName)) {
          const remMatch = trimmed.match(/^([\d.]+)rem$/);
          const pxMatch = trimmed.match(/^([\d.]+)px$/);
          if (/\s+/.test(trimmed)) {
            componentTokens[compName].push({ name: toCamel(propName), raw: value });
          } else if (remMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: parseFloat(remMatch[1]) * 16 });
          } else if (pxMatch) {
            componentTokens[compName].push({ name: toCamel(propName), value: parseFloat(pxMatch[1]) });
          } else {
            const n = parseFloat(trimmed); if (!isNaN(n)) componentTokens[compName].push({ name: toCamel(propName), value: n }); else componentTokens[compName].push({ name: toCamel(propName), raw: value });
          }
        } else {
          componentTokens[compName].push({ name: toCamel(propName), raw: value });
        }
      }
    });

    // ── Build output lines ─────────────────────────────────────────────
    const colorLines = colorTokens.map(t => {
      let line = `    public static let ${t.name}: Color = ${t.darkVal}`;
      if (t.lightVal) line += `\n    public static let ${t.name}Light: Color = ${t.lightVal}`;
      return line;
    }).join('\n');

    const spacingLines = spacingTokens.map(t => `    public static let ${t.name}: CGFloat = ${t.value}`).join('\n');
    const radiusLines = radiusTokens.map(t => `    public static let ${t.name}: CGFloat = ${t.value}`).join('\n');
    const fontSizeLines = fontSizeTokens.map(t => `    public static let ${t.name}: CGFloat = ${t.value}`).join('\n');

    // Shadow output
    const shadowLines = shadowTokens.map(t => {
      if (t.raw) {
        let line = `    // ${t.raw}`;
        if (t.lightRaw) line += ` (light: ${t.lightRaw})`;
        return line;
      }
      let line = `    public static let ${t.name} = ShadowData(offsetX: ${t.x}, offsetY: ${t.y}, blurRadius: ${t.blur}, spread: ${t.spread}, color: ${t.color})`;
      if (t.lightColor) {
        line += `\n    public static let ${t.name}Light = ShadowData(offsetX: ${t.lightX ?? t.x}, offsetY: ${t.lightY ?? t.y}, blurRadius: ${t.lightBlur ?? t.blur}, spread: ${t.lightSpread ?? t.spread}, color: ${t.lightColor})`;
      }
      return line;
    }).join('\n');

    const timeLines = timeTokens.map(t => `    public static let ${t.name}: Double = ${t.value}  // ms`).join('\n');
    const easingLines = easingTokens.map(t =>
      `    public static let ${t.name} = UnitCurve(bezier: UnitCurve.Bezier(x1: ${t.value[0]}, y1: ${t.value[1]}, x2: ${t.value[2]}, y2: ${t.value[3]}))`
    ).join('\n');
    const zIndexLines = zIndexTokens.map(t => `    public static let ${t.name}: Int = ${t.value}`).join('\n');
    const glassLines = glassTokens.map(t => `    public static let ${t.name}: CGFloat = ${t.value}`).join('\n');
    const brightnessLines = brightnessTokens.map(t => `    public static let ${t.name}: Double = ${t.value}`).join('\n');

    // Component output
    const componentObjects = Object.entries(componentTokens).map(([compName, props]) => {
      const objName = `App${compName.charAt(0).toUpperCase() + compName.slice(1)}`;
      const propLines = props.map(p => {
        if (p.raw) return `    // ${p.name}: ${p.raw}`;
        return `    public static let ${p.name} = ${typeof p.value === 'number' ? p.value : p.value}`;
      }).join('\n');
      return `public enum ${objName} {\n${propLines}\n}`;
    }).join('\n\n');

    // Accent theme output (hardcoded, same as Compose)
    const accentBlock = `public enum AppAccent {
    public struct AccentTheme: Sendable {
        public let primary: Color
        public let glow: Color
        public let rgb: String
        public init(primary: Color, glow: Color, rgb: String) {
            self.primary = primary; self.glow = glow; self.rgb = rgb
        }
    }
    public static let blue = AccentTheme(primary: Color(red: 0.000, green: 0.478, blue: 1.000), glow: Color(red: 0.000, green: 0.478, blue: 1.000, opacity: 0.2), rgb: "0, 122, 255")
    public static let green = AccentTheme(primary: Color(red: 0.204, green: 0.781, blue: 0.349), glow: Color(red: 0.204, green: 0.781, blue: 0.349, opacity: 0.2), rgb: "52, 199, 89")
    public static let orange = AccentTheme(primary: Color(red: 1.000, green: 0.584, blue: 0.000), glow: Color(red: 1.000, green: 0.584, blue: 0.000, opacity: 0.2), rgb: "255, 149, 0")
    public static let pink = AccentTheme(primary: Color(red: 1.000, green: 0.176, blue: 0.333), glow: Color(red: 1.000, green: 0.176, blue: 0.333, opacity: 0.2), rgb: "255, 45, 85")
    public static let purple = AccentTheme(primary: Color(red: 0.686, green: 0.322, blue: 0.871), glow: Color(red: 0.686, green: 0.322, blue: 0.871, opacity: 0.2), rgb: "175, 82, 222")
}`;

    return `import SwiftUI

// AUTO-GENERATED — DO NOT EDIT — Source: tokens/src/*.json
// Run: npx style-dictionary build --config=tokens/config.js

public enum AppColors {
${colorLines}
}

public enum AppSpacing {
${spacingLines}
}

public enum AppRadius {
${radiusLines}
}

public enum AppFontSize {
${fontSizeLines}
}

public struct ShadowData: Sendable {
    public let offsetX: CGFloat
    public let offsetY: CGFloat
    public let blurRadius: CGFloat
    public let spread: CGFloat
    public let color: Color
    public init(offsetX: CGFloat, offsetY: CGFloat, blurRadius: CGFloat, spread: CGFloat = 0, color: Color) {
        self.offsetX = offsetX; self.offsetY = offsetY; self.blurRadius = blurRadius; self.spread = spread; self.color = color
    }
}

public enum AppShadow {
${shadowLines}
}

public enum AppTime {
${timeLines}
}

public enum AppEasing {
${easingLines}
}

public enum AppZIndex {
${zIndexLines}
}

public enum AppGlass {
${glassLines}
}

public enum AppBrightness {
${brightnessLines}
}

${componentObjects}

${accentBlock}
`;
  }
});

export default {
  source: ['tokens/src/**/*.json'],
  platforms: {
    css: {
      transformGroup: 'css',
      transforms: ['semantic/dark-light'],
      buildPath: 'tokens/build/css/',
      files: [
        { destination: 'variables.css', format: 'css/variables-themed' },
        { destination: 'theme.css', format: 'css/theme-vars' },
      ],
    },
    compose: {
      transformGroup: 'js',
      transforms: ['semantic/dark-light'],
      buildPath: 'android/app/src/main/java/com/zephyr/ui/theme/',
      files: [{
        destination: 'AppTokens.kt',
        format: 'custom/compose-kotlin',
      }]
    },
    ios_swift: {
      transformGroup: 'js',
      transforms: ['semantic/dark-light'],
      buildPath: 'ios/Sources/DesignSystem/',
      files: [{
        destination: 'AppTokens.swift',
        format: 'custom/swift-constants',
      }]
    },
  },
};
