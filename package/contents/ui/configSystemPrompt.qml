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
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
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

    // The template in use: a blank setting means the built-in default.
    readonly property string effectiveTemplate: (cfg_systemPrompt && cfg_systemPrompt.trim().length > 0)
        ? cfg_systemPrompt : Api.DEFAULT_SYSTEM_PROMPT_TEMPLATE

    readonly property bool anySysInfo: cfg_sysInfoOS || cfg_sysInfoShell || cfg_sysInfoHostname
        || cfg_sysInfoKernel || cfg_sysInfoDesktop || cfg_sysInfoUser || cfg_sysInfoCPU
        || cfg_sysInfoMemory || cfg_sysInfoGPU || cfg_sysInfoDisk || cfg_sysInfoNetwork
        || cfg_sysInfoLocale || cfg_sysInfoDateTime

    // One row per {{tag}}. `on` is whether the feature behind it is turned
    // on; `onlyWhile` marks sections added only during part of a chat;
    // `appended` mirrors Api.buildSystemPrompt: those sections are added at
    // the end when the tag is missing, the others are left out.
    readonly property var sectionRows: [
        { tag: "system_info", name: i18n("System details"),
          what: i18n("The details ticked under System details below."),
          on: anySysInfo, off: i18n("Off: no System details boxes are ticked."),
          appended: false },
        { tag: "memories", name: i18n("Memories"),
          what: i18n("Your pinned memories from the Memory tab (nothing is added while none are pinned)."),
          on: cfg_memoryEnabled, off: i18n("Off: long-term memory is turned off in the Memory tab."),
          appended: true },
        { tag: "skills", name: i18n("Skills"),
          what: i18n("The list of available skills from the Skills tab, plus the full instructions of any skill loaded in the chat."),
          on: cfg_skillsEnabled, off: i18n("Off: skills are turned off in the Skills tab."),
          appended: true },
        { tag: "tools", name: i18n("Tools"),
          what: i18n("How to use each tool turned on in the Tools tab."),
          on: cfg_enableTools, off: i18n("Off: tools are turned off in the Tools tab."),
          appended: false },
        { tag: "session_multiplexer", name: i18n("Persistent session"),
          what: i18n("Notes on the tmux or screen session commands run in."),
          on: cfg_useSessionMultiplexer, off: i18n("Off: persistent session is turned off in the Tools tab."),
          appended: false },
        { tag: "approval_mode", name: i18n("Skip approvals notice"),
          what: i18n("Tells the model its commands run without asking you."),
          on: true, onlyWhile: i18n("only while approvals are skipped (/auto, or a task set to skip approvals)"),
          appended: true },
        { tag: "driving_instructions", name: i18n("Desktop control"),
          what: i18n("Screen coordinates and rules for controlling the desktop."),
          on: cfg_enableTools && cfg_enableDesktopAutomation, onlyWhile: i18n("only while the model is controlling the desktop"),
          off: i18n("Off: tools or desktop automation are turned off in the Tools tab."),
          appended: true },
        { tag: "accuracy", name: i18n("Accuracy"),
          what: i18n("The accuracy text under Accuracy below."),
          on: cfg_accuracyInstructionsEnabled, off: i18n("Off: the Accuracy box below is unticked."),
          appended: true }
    ]

    // { text, color } describing what happens to one section right now.
    function sectionStatus(row) {
        if (!row.on)
            return { text: row.off, color: Kirigami.Theme.disabledTextColor };
        var inTemplate = Api.templateHasSection(effectiveTemplate, row.tag);
        if (row.onlyWhile) {
            return {
                text: inTemplate ? i18n("Added where the tag is, %1.", row.onlyWhile)
                                 : i18n("Added at the end, %1.", row.onlyWhile),
                color: Kirigami.Theme.textColor
            };
        }
        if (inTemplate)
            return { text: i18n("Included where the tag is."), color: Kirigami.Theme.positiveTextColor };
        if (row.appended)
            return { text: i18n("Tag not in your prompt, so it is added at the end."), color: Kirigami.Theme.textColor };
        return { text: i18n("Tag not in your prompt, so it is left out."), color: Kirigami.Theme.negativeTextColor };
    }

    // How many built-in texts the user has changed (promptOverrides keys),
    // so edits are visible while the editors are hidden.
    readonly property int changedBuiltInCount: {
        var n = 0;
        try {
            var o = JSON.parse(cfg_promptOverrides || "{}");
            if (o && typeof o === "object") n = Object.keys(o).length;
        } catch (e) {}
        return n;
    }

    readonly property var builtInRows: [
        { key: "skills", label: i18n("Skills intro"), hint: i18n("Shown under the Skills heading when skills are available.") },
        { key: "session_multiplexer", label: i18n("Persistent session"), hint: i18n("Tokens: {{multiplexer}}, {{session}}, {{attach_command}}") },
        { key: "approval_mode", label: i18n("Skip approvals notice"), hint: i18n("Shown only while skip approvals (/auto) is on.") },
        { key: "memory_heading", label: i18n("Memory heading"), hint: "" },
        { key: "memory_intro", label: i18n("Memory intro"), hint: "" },
        { key: "memory_archive_intro", label: i18n("Memory archive intro"), hint: i18n("Token:") + " %1 " + i18n("(number of archived facts). Shown only when recall is available.") },
        { key: "driving_instructions", label: i18n("Desktop control instructions"), hint: i18n("Shown only while the model is controlling the desktop.") },
        { key: "end_marker", label: i18n("End marker"), hint: i18n("Last line of the system prompt.") },
        { key: "tools_intro", label: i18n("Tools intro"), hint: i18n("Shown under the Tools heading, before the tool list.") }
    ]

    // Wrapping labels and text boxes get a small Layout.preferredWidth and
    // fill the width, so the form never grows wider than the window.
    Kirigami.FormLayout {

        // --- The template ---------------------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Your prompt")
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
            wrapMode: Text.Wrap
            text: i18n("This is the system prompt sent at the start of every message. Write anything you like. Each {{tag}} is swapped for a section the widget builds; the list below says what each one adds, when, and whether it is in your prompt now.")
        }

        QQC2.TextArea {
            id: systemPromptArea
            Kirigami.FormData.label: i18n("System prompt:")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
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

        QQC2.Button {
            text: i18n("Reset to default prompt")
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

        // --- What each tag adds ---------------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("What gets added")
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
            spacing: Kirigami.Units.largeSpacing

            Repeater {
                model: configPage.sectionRows

                delegate: RowLayout {
                    id: sectionRow
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.largeSpacing
                    readonly property var status: configPage.sectionStatus(modelData)

                    QQC2.Button {
                        Layout.alignment: Qt.AlignTop
                        text: "{{" + modelData.tag + "}}"
                        QQC2.ToolTip.text: i18n("Insert this tag at the cursor")
                        QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                        QQC2.ToolTip.visible: hovered
                        onClicked: systemPromptArea.insert(systemPromptArea.cursorPosition, "{{" + modelData.tag + "}}")
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 1
                        spacing: 0

                        QQC2.Label {
                            Layout.fillWidth: true
                            wrapMode: Text.Wrap
                            text: "<b>" + modelData.name + "</b> — " + modelData.what
                            textFormat: Text.StyledText
                        }
                        QQC2.Label {
                            Layout.fillWidth: true
                            wrapMode: Text.Wrap
                            font: Kirigami.Theme.smallFont
                            color: sectionRow.status.color
                            text: sectionRow.status.text
                        }
                    }
                }
            }

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                font: Kirigami.Theme.smallFont
                color: Kirigami.Theme.disabledTextColor
                text: i18n("Tags are matched with or without spaces inside the braces. Single values such as {{hostname}}, {{os}} or {{datetime}} also work, but stay empty unless that box is ticked under System details. Any other tag becomes empty text. The prompt always ends with the end marker line.")
            }
        }

        // --- System details -------------------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("System details")
        }

        GridLayout {
            Kirigami.FormData.label: i18n("Include:")
            columns: 2
            columnSpacing: Kirigami.Units.largeSpacing
            rowSpacing: 0

            Repeater {
                model: [
                    { key: "sysInfoOS", label: i18n("OS") },
                    { key: "sysInfoShell", label: i18n("Shell") },
                    { key: "sysInfoHostname", label: i18n("Hostname") },
                    { key: "sysInfoKernel", label: i18n("Kernel") },
                    { key: "sysInfoDesktop", label: i18n("Desktop") },
                    { key: "sysInfoUser", label: i18n("User") },
                    { key: "sysInfoCPU", label: i18n("CPU") },
                    { key: "sysInfoMemory", label: i18n("Memory") },
                    { key: "sysInfoGPU", label: i18n("GPU") },
                    { key: "sysInfoDisk", label: i18n("Block Devices") },
                    { key: "sysInfoNetwork", label: i18n("Network") },
                    { key: "sysInfoLocale", label: i18n("Locale") },
                    { key: "sysInfoDateTime", label: i18n("Date/Time") }
                ]
                delegate: QQC2.CheckBox {
                    text: modelData.label
                    checked: configPage["cfg_" + modelData.key]
                    onToggled: {
                        if (_initialized) {
                            configPage["cfg_" + modelData.key] = checked;
                            rootItem.triggerCapture();
                        }
                    }
                }
            }
        }

        // --- Accuracy -------------------------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Accuracy")
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
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
                Layout.preferredWidth: Kirigami.Units.gridUnit * 26
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
                text: i18n("Safe to reword: this is plain guidance and no feature depends on it. It cannot get past a provider's content filter, which rejects the request before the model sees it.")
                color: Kirigami.Theme.disabledTextColor
                font: Kirigami.Theme.smallFont
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
        }

        // --- Built-in text (advanced) ---------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Built-in text")
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
            spacing: Kirigami.Units.largeSpacing

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: Kirigami.Theme.disabledTextColor
                font: Kirigami.Theme.smallFont
                text: configPage.changedBuiltInCount > 0
                    ? i18n("The wording of the sections above, plus each tool's instructions. You have changed %1 of them.", configPage.changedBuiltInCount)
                    : i18n("The wording of the sections above, plus each tool's instructions. All are at their defaults.")
            }

            RowLayout {
                spacing: Kirigami.Units.smallSpacing

                QQC2.Button {
                    text: builtInAdvanced.visible ? i18n("Hide built-in text") : i18n("Advanced: edit built-in text…")
                    icon.name: "configure"
                    onClicked: builtInAdvanced.visible = !builtInAdvanced.visible
                }

                QQC2.Button {
                    text: i18n("Reset all built-in text")
                    icon.name: "edit-undo"
                    visible: configPage.changedBuiltInCount > 0
                    onClicked: {
                        if (cfg_promptOverrides !== "") {
                            cfg_promptOverrides = "";
                            rootItem.triggerCapture();
                        }
                        // The editors are not bound to the setting; refill
                        // them by re-creating the hidden section.
                        if (builtInAdvanced.visible) {
                            builtInAdvanced.visible = false;
                            builtInAdvanced.visible = true;
                        }
                    }
                }
            }

            ColumnLayout {
                id: builtInAdvanced
                visible: false
                Layout.fillWidth: true
                spacing: Kirigami.Units.largeSpacing

                QQC2.Label {
                    text: i18n("Features depend on this text. A bad edit can stop the model from using tools, memory, skills or desktop control. If something stops working, reset that section here. Edits apply even when the system prompt is localized, and a tool edit here takes precedence over that tool's text in Tools settings.")
                    color: Kirigami.Theme.neutralTextColor
                    font: Kirigami.Theme.smallFont
                    wrapMode: Text.Wrap
                    Layout.fillWidth: true
                    Layout.preferredWidth: 1
                }

                // Created only while shown, so they refill from the setting
                // each time the section opens.
                Repeater {
                    model: builtInAdvanced.visible ? configPage.builtInRows : []

                    delegate: OverrideEditor {
                        key: modelData.key
                        label: modelData.label
                        hint: modelData.hint
                        defaultText: Api.PROMPT_DEFAULTS[modelData.key]
                    }
                }

                Repeater {
                    model: builtInAdvanced.visible ? configPage.toolOverrideModel() : []

                    delegate: OverrideEditor {
                        key: modelData.key
                        label: modelData.label
                        defaultText: modelData.defaultText
                        hint: ""
                    }
                }
            }
        }

        // --- Localization ---------------------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Language")
            visible: !Qt.locale().name.toLowerCase().startsWith("en")
        }

        ColumnLayout {
            Kirigami.FormData.label: i18n("Localization:")
            visible: !Qt.locale().name.toLowerCase().startsWith("en")
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
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

        // --- Preview --------------------------------------------------------

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Preview")
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
            wrapMode: Text.Wrap
            font: Kirigami.Theme.smallFont
            color: Kirigami.Theme.disabledTextColor
            text: i18n("What the model receives with your current settings. Not shown here: sections added only during part of a chat (skip approvals, desktop control), your memories, and the skills list.")
        }

        QQC2.TextArea {
            Layout.fillWidth: true
            Layout.preferredWidth: Kirigami.Units.gridUnit * 26
            Layout.minimumHeight: Kirigami.Units.gridUnit * 14
            readOnly: true
            wrapMode: Text.Wrap
            font.family: "monospace"
            font.pointSize: Kirigami.Theme.smallFont.pointSize
            text: promptPreview
        }
    }
}
