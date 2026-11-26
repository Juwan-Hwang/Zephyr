// Global type declarations for js-yaml loaded via script tag
declare const jsyaml: {
    load(input: string, options?: { schema?: unknown }): any;
    DEFAULT_SCHEMA: { extend(definition: { implicit: unknown[] }): unknown };
    Type: new (tag: string, options: { kind: string; resolve: (value: string) => boolean; construct: (value: string) => unknown }) => unknown;
    types: { timestamp: { resolve: (value: string) => boolean } };
    dump(obj: any, options?: { indent?: number; lineWidth?: number; quotingType?: string; forceQuotes?: boolean; sortKeys?: boolean | ((a: string, b: string) => number) }): string;
};
