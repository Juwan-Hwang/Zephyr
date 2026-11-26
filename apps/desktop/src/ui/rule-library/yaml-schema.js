// @ts-check

/** Parse Prism metadata without coercing date-like identifiers to Date objects.
 * Merge keys and the remaining default YAML types keep their existing behavior.
 * @param {string} content
 */
export function loadPrismYaml(content) {
    const schema = jsyaml.DEFAULT_SCHEMA.extend({ implicit: [new jsyaml.Type('tag:yaml.org,2002:timestamp', {
        kind: 'scalar', resolve: jsyaml.types.timestamp.resolve, construct: (/** @type {string} */ value) => value,
    })] });
    return jsyaml.load(content, { schema });
}
