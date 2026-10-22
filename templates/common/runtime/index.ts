import { PLUGIN_ENABLED } from './plugin-enabled';

export interface {{CLASS}}NativeAPI {
    ping(): string;
    version(): string;
    add(left: number, right: number): number;
{{NATIVE_API_EXTRA}}
}

declare global {
    // Name includes a hash of the package name to avoid JSB global collisions.
    var {{NATIVE_CLASS}}: {{CLASS}}NativeAPI | undefined;
}

function nativeBridge(): {{CLASS}}NativeAPI | undefined {
    return PLUGIN_ENABLED ? globalThis.{{NATIVE_CLASS}} : undefined;
}

/** Remains importable in browser preview and when disabled. */
export const {{CLASS}} = {
    get enabled(): boolean { return PLUGIN_ENABLED; },
    get available(): boolean { return nativeBridge() !== undefined; },
    ping(): string { return nativeBridge()?.ping() ?? '{{NAME}}: JavaScript fallback'; },
    version(): string { return nativeBridge()?.version() ?? '0.1.0-fallback'; },
    add(left: number, right: number): number { return nativeBridge()?.add(left, right) ?? left + right; },
{{TS_EXTRA}}
};
