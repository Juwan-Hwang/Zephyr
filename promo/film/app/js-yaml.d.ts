// Global type declarations for js-yaml loaded via script tag
declare const jsyaml: {
    load(input: string): any;
    dump(obj: any, options?: { indent?: number; lineWidth?: number; quotingType?: string; forceQuotes?: boolean }): string;
};
