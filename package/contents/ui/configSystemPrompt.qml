/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami
import org.kde.kcmutils

import "api.js" as Api
import "toolManager.js" as ToolManager

BaseConfigPage {
    id: configPage

    // promptOverrides is a JSON object { key: text }; a missing key means the
    // built-in default (see Api.PROMPT_DEFAULTS and the tool: keys).
    function overrideMap() {
        try {
            var o = JSON.parse(cfg_promptOverrides || "{}");
            return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
        } catch (e) {
            return {};
        }
    }

    function overrideText(key, defaultText) {
        var v = overrideMap()[key];
        return (typeof v === "string" && v.trim().length > 0) ? v : defaultText;
    }

    function setOverrideText(key, text, defaultText) {
        var m = overrideMap();
        // Blank or equal to the default: drop the key so later changes to the
        // built-in text still reach the user.
        if (text.trim().length === 0 || text.trim() === defaultText.trim()) delete m[key];
        else m[key] = text;
        var json = Object.keys(m).length > 0 ? JSON.stringify(m) : "";
        if (json !== cfg_promptOverrides) cfg_promptOverrides = json;
    }

    function toolOverrideModel() {
        var ids = ToolManager.getPromptToolIds();
        var cfg = buildToolsConfig();
        var model = [];
        for (var i = 0; i < ids.length; i++) {
            var meta = ToolManager.TOOLS[ids[i]];
            model.push({
                key: "tool:" + ids[i],
                label: (meta && meta.displayName) ? meta.displayName : ids[i],
                // What the prompt uses without an override here: the Tools-settings text, localized.
                defaultText: ToolManager.getToolInstruction(ids[i], cfg, i18n),
                hint: ""
            });
        }
        return model;
    }

    component OverrideEditor: ColumnLayout {
        id: editor
        property string key
        property string label
        property string defaultText
        property string hint
        Layout.fillWidth: true
        spacing: Kirigami.Units.smallSpacing

        QQC2.Label {
            text: editor.label
            font.bold: true
        }

        QQC2.TextArea {
            id: editorArea
            Layout.fillWidth: true
            Layout.minimumHeight: Kirigami.Units.gridUnit * 4
            wrapMode: Text.Wrap
            font.family: "monospace"
            font.pointSize: Kirigami.Theme.smallFont.pointSize
            // Not bound: a blank box must stay blank while the user retypes.
            function refill() {
                var t = configPage.overrideText(editor.key, editor.defaultText);
                if (text !== t) text = t;
            }
            Component.onCompleted: refill()
            Connections {
                target: configPage
                function on_InitializedChanged() { editorArea.refill(); }
                function on_SwitchingProfileChanged() { if (!configPage._switchingProfile) editorArea.refill(); }
            }
            onTextChanged: {
                if (_initialized) {
                    configPage.setOverrideText(editor.key, text, editor.defaultText);
                    rootItem.triggerCapture();
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.largeSpacing

            QQC2.Button {
                text: i18n("Reset to default")
                icon.name: "edit-undo"
                enabled: editorArea.text.trim() !== editor.defaultText.trim()
                onClicked: editorArea.text = editor.defaultText
            }

            QQC2.Label {
                visible: editor.hint.length > 0
                text: editor.hint
                color: Kirigami.Theme.disabledTextColor
                font: Kirigami.Theme.smallFont
                wrapMode: Text.Wrap
                Layout.fillWidth: true
                Layout.preferredWidth: 1
            }
        }
    }

    function buildToolsConfig() {
        return {
            i18n: i18n,
            sessionAutoMode: false,
            sessionFullAutoMode: false,
            enableTools: cfg_enableTools,
            enableWebSearch: cfg_enableWebSearch,
            enableDesktopAutomation: cfg_enableDesktopAutomation,
            searchConfigured: false,
            useCommandTool: cfg_useCommandTool,
            autoRunCommands: cfg_autoRunCommands,
            toolsReadFileEnabled: cfg_toolsReadFileEnabled,
            toolsReadFileAutoRun: cfg_toolsReadFileAutoRun,
            toolsWriteFileEnabled: cfg_toolsWriteFileEnabled,
            toolsWriteFileAutoRun: cfg_toolsWriteFileAutoRun,
            toolsListDirEnabled: cfg_toolsListDirEnabled,
            toolsListDirAutoRun: cfg_toolsListDirAutoRun,
            toolsHttpGetEnabled: cfg_toolsHttpGetEnabled,
            toolsHttpGetAutoRun: cfg_toolsHttpGetAutoRun,
            toolsHttpRequestEnabled: cfg_toolsHttpRequestEnabled,
            toolsHttpRequestAutoRun: cfg_toolsHttpRequestAutoRun,
            toolsSearchFilesEnabled: cfg_toolsSearchFilesEnabled,
            toolsSearchFilesAutoRun: cfg_toolsSearchFilesAutoRun,
            toolsGetClipboardEnabled: cfg_toolsGetClipboardEnabled,
            toolsGetClipboardAutoRun: cfg_toolsGetClipboardAutoRun,
            toolsSetClipboardEnabled: cfg_toolsSetClipboardEnabled,
            toolsSetClipboardAutoRun: cfg_toolsSetClipboardAutoRun,
            toolsNotifyEnabled: cfg_toolsNotifyEnabled,
            toolsNotifyAutoRun: cfg_toolsNotifyAutoRun,
            toolsOpenUrlEnabled: cfg_toolsOpenUrlEnabled,
            toolsOpenUrlAutoRun: cfg_toolsOpenUrlAutoRun,
            toolsEditMemoryEnabled: cfg_toolsEditMemoryEnabled,
            toolsEditMemoryAutoRun: cfg_toolsEditMemoryAutoRun,
            toolsSkillEnabled: cfg_toolsSkillEnabled,
            toolsRunSkillScriptEnabled: cfg_toolsRunSkillScriptEnabled,
            skillsEnabled: cfg_skillsEnabled,
            skillsDisabledList: cfg_skillsDisabledList,
            skillsScriptsAutoRun: cfg_skillsScriptsAutoRun,
            memoryPhrases: cfg_memoryPhrases,
            toolsPathWhitelist: cfg_toolsPathWhitelist,
            toolsReadMaxBytes: cfg_toolsReadMaxBytes,
            toolsWriteMaxBytes: cfg_toolsWriteMaxBytes,
            toolsHttpMaxBytes: cfg_toolsHttpMaxBytes,
            toolsInstructions: cfg_toolsInstructions,
            localizeSystemPrompt: cfg_localizeSystemPrompt,
            customTools: cfg_customTools
        };
    }

    function buildPreview() {
        var real = {};
        try { if (cfg_gatheredSysInfo) real = JSON.parse(cfg_gatheredSysInfo); } catch(e) {}
        var info = {};
        if (cfg_sysInfoOS)       info.osRelease  = real.osRelease  || "<OS name>";
        if (cfg_sysInfoShell)    info.shell       = real.shell      || "<shell>";
        if (cfg_sysInfoHostname) info.hostname    = real.hostname   || "<hostname>";
        if (cfg_sysInfoKernel)   info.kernel      = real.kernel     || "<kernel>";
        if (cfg_sysInfoDesktop)  info.desktop     = real.desktop    || "<desktop>";
        if (cfg_sysInfoUser)     info.user        = real.user       || "<username>";
        if (cfg_sysInfoCPU) {
            info.cpu      = real.cpu      || "<CPU model>";
            info.cpuCores = real.cpuCores || "<cores>";
            info.cpuArch  = real.cpuArch  || "<arch>";
        }
        if (cfg_sysInfoMemory)   info.memory  = real.memory  || "<memory>";
        if (cfg_sysInfoGPU)      info.gpu     = real.gpu     || "<GPU name>";
        if (cfg_sysInfoDisk)     info.disk    = real.disk    || "<lsblk output>";
        if (cfg_sysInfoNetwork)  info.network = real.network || "<network>";
        if (cfg_sysInfoLocale)   info.locale  = real.locale  || "<locale>";
        return Api.buildSystemPrompt(info, cfg_systemPrompt, {
            i18n: i18n,
            sysInfoDateTime: cfg_sysInfoDateTime,
            accuracyEnabled: cfg_accuracyInstructionsEnabled,
            accuracyText: cfg_accuracyInstructions,
            promptOverrides: cfg_promptOverrides,
            autoRunCommands: cfg_autoRunCommands,
            autoMode: false,
            commandToolEnabled: cfg_useCommandTool,
            sessionMultiplexer: cfg_useSessionMultiplexer ? (cfg_sessionMultiplexer + ": " + cfg_sessionName) : "",
            localizeSystemPrompt: cfg_localizeSystemPrompt,
            toolsConfig: buildToolsConfig()
        });
    }

    property string promptPreview: buildPreview()

    Kirigami.FormLayout {
        GridLayout {
            Kirigami.FormData.label: i18n("System Info:")
            columns: 2
            columnSpacing: Kirigami.Units.largeSpacing
            rowSpacing: 0

            QQC2.CheckBox {
                text: i18n("OS")
                checked: cfg_sysInfoOS
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoOS = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Shell")
                checked: cfg_sysInfoShell
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoShell = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Hostname")
                checked: cfg_sysInfoHostname
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoHostname = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Kernel")
                checked: cfg_sysInfoKernel
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoKernel = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Desktop")
                checked: cfg_sysInfoDesktop
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoDesktop = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("User")
                checked: cfg_sysInfoUser
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoUser = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("CPU")
                checked: cfg_sysInfoCPU
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoCPU = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Memory")
                checked: cfg_sysInfoMemory
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoMemory = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("GPU")
                checked: cfg_sysInfoGPU
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoGPU = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Block Devices")
                checked: cfg_sysInfoDisk
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoDisk = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Network")
                checked: cfg_sysInfoNetwork
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoNetwork = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Locale")
                checked: cfg_sysInfoLocale
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoLocale = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
            QQC2.CheckBox {
                text: i18n("Date/Time")
                checked: cfg_sysInfoDateTime
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_sysInfoDateTime = checked;
                        rootItem.triggerCapture();
                    }
                }
            }
        }

        QQC2.Label {
            Kirigami.FormData.label: i18n("Template:")
            Kirigami.FormData.isSection: true
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            Layout.topMargin: Kirigami.Units.largeSpacing
            text: i18n("This is the full system prompt sent to the model. Use {{placeholders}} to pull in dynamic content like system details, enabled tools, or desktop automation instructions. Anything else you write is used verbatim. Critical runtime instructions (driving, skip-approvals mode) are appended automatically when active, even if you remove their placeholder.")
            wrapMode: Text.Wrap
        }

        QQC2.TextArea {
            id: systemPromptArea
            Kirigami.FormData.label: i18n("System Prompt:")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            Layout.minimumHeight: Kirigami.Units.gridUnit * 12
            placeholderText: i18n("Write your system prompt here…")
            wrapMode: Text.Wrap
            font.family: "monospace"
            font.pointSize: Kirigami.Theme.smallFont.pointSize
            text: cfg_systemPrompt
            onTextChanged: {
                if (_initialized) {
                    cfg_systemPrompt = text;
                    rootItem.triggerCapture();
                }
            }
        }

        ColumnLayout {
            Kirigami.FormData.label: i18n("Placeholders:")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            spacing: Kirigami.Units.smallSpacing

            Repeater {
                model: [
                    { tag: "{{system_info}}", desc: i18n("Enabled system info selected in the checklist above") },
                    { tag: "{{tools}}", desc: i18n("Enabled tool descriptions and guidelines from the Tools menu") },
                    { tag: "{{skills}}", desc: i18n("Available skills index and instructions for skills loaded this session (from the Skills settings page)") },
                    { tag: "{{session_multiplexer}}", desc: i18n("Persistent tmux or screen session multiplexer instructions (when active)") },
                    { tag: "{{approval_mode}}", desc: i18n("Notice indicating skip-approvals mode (/auto) is active") },
                    { tag: "{{driving_instructions}}", desc: i18n("Desktop automation coordinates and guidelines (when driving)") },
                    { tag: "{{accuracy}}", desc: i18n("Accuracy instructions from the section below (appended at the end when the tag is absent)") }
                ]

                delegate: RowLayout {
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.largeSpacing

                    QQC2.Button {
                        text: modelData.tag
                        icon.name: "list-add"
                        onClicked: systemPromptArea.insert(systemPromptArea.cursorPosition, modelData.tag)
                    }

                    QQC2.Label {
                        text: modelData.desc
                        color: Kirigami.Theme.disabledTextColor
                        font: Kirigami.Theme.smallFont
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        Layout.preferredWidth: 1
                    }
                }
            }
        }

        ColumnLayout {
            Kirigami.FormData.label: i18n("Accuracy:")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            spacing: Kirigami.Units.smallSpacing

            QQC2.CheckBox {
                text: i18n("Ask every model to answer factually, including sensitive topics")
                checked: cfg_accuracyInstructionsEnabled
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_accuracyInstructionsEnabled = checked;
                        rootItem.triggerCapture();
                    }
                }
            }

            QQC2.TextArea {
                id: accuracyArea
                Layout.fillWidth: true
                Layout.minimumHeight: Kirigami.Units.gridUnit * 6
                enabled: cfg_accuracyInstructionsEnabled
                wrapMode: Text.Wrap
                font.family: "monospace"
                font.pointSize: Kirigami.Theme.smallFont.pointSize
                // Not bound: a blank box must stay blank while the user retypes.
                function refill() {
                    var t = cfg_accuracyInstructions.length > 0 ? cfg_accuracyInstructions : Api.ACCURACY_INSTRUCTIONS;
                    if (text !== t) text = t;
                }
                Component.onCompleted: refill()
                Connections {
                    target: configPage
                    function on_InitializedChanged() { accuracyArea.refill(); }
                    function on_SwitchingProfileChanged() { if (!configPage._switchingProfile) accuracyArea.refill(); }
                }
                onTextChanged: {
                    if (_initialized) {
                        // Store blank when it matches the default, so a later
                        // change to the built-in text still reaches the user.
                        cfg_accuracyInstructions = (text.trim() === Api.ACCURACY_INSTRUCTIONS) ? "" : text;
                        rootItem.triggerCapture();
                    }
                }
            }

            QQC2.Button {
                text: i18n("Reset to default")
                icon.name: "edit-undo"
                enabled: cfg_accuracyInstructionsEnabled && cfg_accuracyInstructions.length > 0
                onClicked: accuracyArea.text = Api.ACCURACY_INSTRUCTIONS
            }

            QQC2.Label {
                text: i18n("Added to the end of the system prompt unless you place {{accuracy}} in the template. It cannot get past a provider's content filter, which rejects the request before the model sees it.")
                color: Kirigami.Theme.disabledTextColor
                font: Kirigami.Theme.smallFont
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
        }

        ColumnLayout {
            Kirigami.FormData.label: i18n("Built-in sections:")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            spacing: Kirigami.Units.largeSpacing

            QQC2.Label {
                text: i18n("Text the widget adds to the system prompt on its own. Edit any of it, or reset a section to restore the built-in wording. These edits apply even when the system prompt is localized.")
                color: Kirigami.Theme.disabledTextColor
                font: Kirigami.Theme.smallFont
                wrapMode: Text.Wrap
                Layout.fillWidth: true
                Layout.preferredWidth: 1
            }

            Repeater {
                model: [
                    { key: "skills", label: i18n("Skills intro"), hint: i18n("Shown under the Skills heading when skills are available.") },
                    { key: "session_multiplexer", label: i18n("Session multiplexer"), hint: i18n("Tokens: {{multiplexer}}, {{session}}, {{attach_command}}") },
                    { key: "approval_mode", label: i18n("Skip approvals mode notice"), hint: i18n("Shown only while skip-approvals mode is active.") },
                    { key: "memory_heading", label: i18n("Memory heading"), hint: "" },
                    { key: "memory_intro", label: i18n("Memory intro"), hint: "" },
                    { key: "memory_archive_intro", label: i18n("Memory archive intro"), hint: i18n("Token:") + " %1 " + i18n("(number of archived facts). Shown only when recall is available.") },
                    { key: "driving_instructions", label: i18n("Desktop driving instructions"), hint: i18n("Shown only while desktop automation is driving.") },
                    { key: "end_marker", label: i18n("End marker"), hint: i18n("Last line of the system prompt.") }
                ]

                delegate: OverrideEditor {
                    key: modelData.key
                    label: modelData.label
                    hint: modelData.hint
                    defaultText: Api.PROMPT_DEFAULTS[modelData.key]
                }
            }

            QQC2.Button {
                text: toolsAdvanced.visible ? i18n("Hide advanced: tool instructions") : i18n("Advanced: tool instructions…")
                icon.name: "configure"
                onClicked: toolsAdvanced.visible = !toolsAdvanced.visible
            }

            ColumnLayout {
                id: toolsAdvanced
                visible: false
                Layout.fillWidth: true
                spacing: Kirigami.Units.largeSpacing

                QQC2.Label {
                    text: i18n("Editing these can break tool calling. If a tool stops working, reset its text to the default. An edit here takes precedence over the tool's text in Tools settings.")
                    color: Kirigami.Theme.neutralTextColor
                    font: Kirigami.Theme.smallFont
                    wrapMode: Text.Wrap
                    Layout.fillWidth: true
                    Layout.preferredWidth: 1
                }

                OverrideEditor {
                    key: "tools_intro"
                    label: i18n("Tools intro")
                    defaultText: Api.PROMPT_DEFAULTS.tools_intro
                    hint: i18n("Shown under the Tools heading, before the tool list.")
                }

                Repeater {
                    model: toolsAdvanced.visible ? configPage.toolOverrideModel() : []

                    delegate: OverrideEditor {
                        key: modelData.key
                        label: modelData.label
                        defaultText: modelData.defaultText
                        hint: ""
                    }
                }
            }
        }

        ColumnLayout {
            Kirigami.FormData.label: i18n("Localization:")
            visible: !Qt.locale().name.toLowerCase().startsWith("en")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            spacing: Kirigami.Units.smallSpacing

            QQC2.CheckBox {
                text: i18n("Localize System Prompt")
                checked: cfg_localizeSystemPrompt
                onCheckedChanged: {
                    if (_initialized) {
                        cfg_localizeSystemPrompt = checked;
                        rootItem.triggerCapture();
                    }
                }
                QQC2.ToolTip.text: i18n("Translate default prompt templates and dynamic system sections into your desktop language.")
            }

            QQC2.Label {
                text: i18n("Note: Localizing system instructions and tools into non-English languages may reduce tool-calling reliability and instruction-following accuracy on some models.")
                visible: cfg_localizeSystemPrompt
                color: Kirigami.Theme.neutralTextColor
                font: Kirigami.Theme.smallFont
                wrapMode: Text.Wrap
                Layout.fillWidth: true
                Layout.preferredWidth: 1
            }
        }

        QQC2.Button {
            Kirigami.FormData.label: i18n("Actions:")
            text: i18n("Reset to Default Template")
            icon.name: "edit-undo"
            onClicked: {
                if (_initialized) {
                    var defTpl = cfg_localizeSystemPrompt ? Api.getLocalizedDefaultSystemPromptTemplate(i18n) : Api.DEFAULT_SYSTEM_PROMPT_TEMPLATE;
                    cfg_systemPrompt = defTpl;
                    systemPromptArea.text = cfg_systemPrompt;
                    rootItem.triggerCapture();
                }
            }
        }

        QQC2.TextArea {
            Kirigami.FormData.label: i18n("Preview:")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 32
            Layout.minimumHeight: Kirigami.Units.gridUnit * 14
            readOnly: true
            wrapMode: Text.Wrap
            font.family: "monospace"
            font.pointSize: Kirigami.Theme.smallFont.pointSize
            text: promptPreview
        }
    }
}
