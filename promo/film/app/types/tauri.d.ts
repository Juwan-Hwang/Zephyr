// ═══════════════════════════════════════════════════════════════════════════════
//  Tauri v2 Global Type Declarations
// ═══════════════════════════════════════════════════════════════════════════════
//  Minimal type declarations for Tauri's __TAURI_INTERNALS__ IPC bridge.
//  Only covers APIs actually used by the project — extend as needed.
// ═══════════════════════════════════════════════════════════════════════════════

interface TauriEvent<T = unknown> {
    payload: T;
}

interface UnlistenFn {
    (): void;
}

interface TauriInvoke {
    <T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriListen {
    <T = unknown>(event: string, handler: (event: TauriEvent<T>) => void): Promise<UnlistenFn>;
}

interface TauriConvertFileSrc {
    (filePath: string, protocol?: string): string;
}

interface TauriOpenUrl {
    (url: string): Promise<void>;
}

interface TauriWindow {
    close(): Promise<void>;
    setTitle(title: string): Promise<void>;
    center(): Promise<void>;
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    startDragging(): Promise<void>;
}

interface TauriTransformCallback {
    <T = unknown>(
        handler: ((...args: T[]) => void) | undefined,
        once?: boolean,
        existingId?: number,
    ): number;
}

interface TauriUnregisterCallback {
    (callbackId: number): void;
}

interface TauriMetadata {
    currentWindow?: {
        label: string;
    };
}

interface TauriInternals {
    invoke: TauriInvoke;
    convertFileSrc: TauriConvertFileSrc;
    open: TauriOpenUrl;
    transformCallback: TauriTransformCallback;
    unregisterCallback?: TauriUnregisterCallback;
    metadata: TauriMetadata;
    window: {
        getCurrentWindow(): TauriWindow;
    };
}

interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
}
