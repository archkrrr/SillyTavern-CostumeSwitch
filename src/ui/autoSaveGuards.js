export function registerAutoSaveGuards({ flushFn, target = globalThis } = {}) {
    if (typeof flushFn !== "function" || !target || typeof target.addEventListener !== "function") {
        return () => {};
    }

    const handler = () => {
        flushFn({
            overrideMessage: null,
            showStatusMessage: false,
            force: true,
        });
    };

    target.addEventListener("beforeunload", handler);
    target.addEventListener("visibilitychange", handler);

    return () => {
        if (typeof target.removeEventListener !== "function") {
            return;
        }
        target.removeEventListener("beforeunload", handler);
        target.removeEventListener("visibilitychange", handler);
    };
}
