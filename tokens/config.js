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
  },
};
