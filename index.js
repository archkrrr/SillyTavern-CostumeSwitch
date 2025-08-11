ST.registerExtension({
    name: "Auto Costume Switcher",
    async init() {
        console.log("[AutoCostume] Extension loaded.");

        const MODULE = 'auto-costume-switcher';
        const DEFAULTS = {
            enabled: true,
            mappings: {
                Shido: '/costume Date a Live',
                Kotori: '/costume Date a Live/Kotori1'
            },
            defaultCommand: '/costume Date a Live',
            idleTimeout: 3000
        };

        const ctx = SillyTavern.getContext();
        ctx.extensionSettings[MODULE] ??= DEFAULTS;
        const settings = ctx.extensionSettings[MODULE];

        function save() {
            ctx.saveSettingsDebounced?.();
        }

        function sendSlash(cmd) {
            ctx.chat.push({ is_user: true, mes: cmd, send_date: Date.now() });
            ctx.eventSource.emit(ctx.event_types.MESSAGE_SENT, { message: cmd });
        }

        let lastName = null;
        let idleTimer = null;

        function resetIdleTimer() {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (lastName) {
                    sendSlash(settings.defaultCommand);
                    lastName = null;
                }
            }, settings.idleTimeout);
        }

        function checkNames(text) {
            if (!settings.enabled) return;
            for (const name in settings.mappings) {
                if (new RegExp(`\\b${name}\\b`, 'i').test(text) && lastName !== name) {
                    lastName = name;
                    sendSlash(settings.mappings[name]);
                }
            }
            resetIdleTimer();
        }

        ctx.eventSource.on(ctx.event_types.MESSAGE_PART, payload => {
            checkNames(payload?.text || payload || '');
        });

        // Simple toggle UI
        const ui = $(`
            <div>
                <label>
                    <input type="checkbox" id="acs-enabled">
                    Enable real-time costume switching
                </label>
                <button id="acs-reset">Reset Costume</button>
            </div>
        `);

        $("#extensions-settings").append(ui);

        $("#acs-enabled")
            .prop("checked", settings.enabled)
            .on("change", e => {
                settings.enabled = e.target.checked;
                save();
            });

        $("#acs-reset").on("click", () => {
            sendSlash(settings.defaultCommand);
            lastName = null;
        });
    }
});
