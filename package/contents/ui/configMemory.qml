/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami
import org.kde.kcmutils
import org.kde.plasma.plasma5support as P5Support

import "memoryStore.js" as MemoryStore

// Memories live in a JSONL file, not in Plasmoid.configuration, so this page
// reads and rewrites that file directly. The widget is told to reload by
// bumping cfg_memoryRevision — settings and the running applet are separate
// QML contexts and cannot share the in-memory list.
BaseConfigPage {
    id: memoryPage

    title: i18n("Memory")

    property var memories: []
    property bool loaded: false
    property string statusText: ""
    property string filterText: ""

    readonly property int pinnedCount: MemoryStore.countPinned(memoryPage.memories)
    readonly property int archivedCount: memoryPage.memories.length - memoryPage.pinnedCount

    readonly property string memoryPath: "${XDG_DATA_HOME:-$HOME/.local/share}/plasmallm/memories.jsonl"

    // Pinned first, then newest last-written first, then the filter applied.
    // Sorting here rather than in the store keeps the file in insertion order,
    // which is what makes eviction predictable.
    function visibleMemories() {
        var needle = memoryPage.filterText.toLowerCase().trim();
        var list = [];
        for (var i = 0; i < memoryPage.memories.length; i++) {
            var m = memoryPage.memories[i];
            if (needle.length > 0) {
                var hay = (m.text + " " + (m.tags || []).join(" ")).toLowerCase();
                if (hay.indexOf(needle) === -1) continue;
            }
            list.push(m);
        }
        list.sort(function(a, b) {
            var ap = a.pinned === true ? 0 : 1;
            var bp = b.pinned === true ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return (b.created || "") < (a.created || "") ? -1 : 1;
        });
        return list;
    }

    P5Support.DataSource {
        id: executable
        engine: "executable"
        connectedSources: []

        property string readCmd: ""
        property string writeCmd: ""

        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined) return;
            var stdout = data["stdout"] ? data["stdout"] : "";

            if (source === readCmd) {
                var parsed = MemoryStore.parseJsonl(stdout);
                memoryPage.memories = parsed.memories;
                memoryPage.loaded = true;
                if (parsed.skipped > 0)
                    memoryPage.statusText = i18n("Skipped %1 unreadable entries.", parsed.skipped);
            } else if (source === writeCmd) {
                // Tell the running widget to re-read the file.
                cfg_memoryRevision = cfg_memoryRevision + 1;
            }
            disconnectSource(source);
        }
    }

    function loadMemories() {
        var cmd = "cat \"" + memoryPath + "\" 2>/dev/null || true";
        executable.readCmd = cmd;
        executable.connectSource(cmd);
    }

    function persistMemories() {
        var text = MemoryStore.serializeJsonl(memoryPage.memories);
        var escaped = text.replace(/'/g, "'\\''");
        var cmd = "mkdir -p \"${XDG_DATA_HOME:-$HOME/.local/share}/plasmallm\" && printf '%s' '"
                + escaped + "' > \"" + memoryPath + "\"";
        executable.writeCmd = cmd;
        executable.connectSource(cmd);
    }

    Component.onCompleted: loadMemories()

    Kirigami.FormLayout {
        anchors.fill: parent

        QQC2.CheckBox {
            id: enabledCheck
            Kirigami.FormData.label: i18n("Long-term memory:")
            text: i18n("Let the assistant save and recall facts between conversations")
            checked: cfg_memoryEnabled
            onToggled: cfg_memoryEnabled = checked
        }

        QQC2.CheckBox {
            text: i18n("Save and delete memories without asking")
            enabled: cfg_memoryEnabled
            checked: cfg_memoryAutoRun
            onToggled: cfg_memoryAutoRun = checked
        }

        QQC2.Label {
            Kirigami.FormData.label: ""
            text: i18n("Pinned memories are added to the system prompt on every message, so keep that set small. Everything else is archived: it costs nothing until the assistant searches for it with the recall tool. Requires Tools to be enabled.")
            wrapMode: Text.Wrap
            Layout.maximumWidth: Kirigami.Units.gridUnit * 24
            opacity: 0.7
        }

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Saved memories")
        }

        RowLayout {
            Kirigami.FormData.label: i18n("Add:")
            QQC2.TextField {
                id: newMemoryField
                Layout.preferredWidth: Kirigami.Units.gridUnit * 20
                placeholderText: i18n("A fact worth remembering…")
                onAccepted: addButton.clicked()
            }
            QQC2.Button {
                id: addButton
                text: i18n("Add")
                icon.name: "list-add"
                enabled: newMemoryField.text.trim().length > 0
                onClicked: {
                    var result = MemoryStore.addMemory(memoryPage.memories,
                                                       newMemoryField.text,
                                                       new Date().toISOString(),
                                                       "user");
                    if (result.added) {
                        memoryPage.memories = result.memories;
                        memoryPage.statusText = result.pinned
                            ? ""
                            : i18n("Added to the archive — the assistant will find it with recall.");
                        persistMemories();
                        newMemoryField.text = "";
                    } else if (result.reason === "duplicate") {
                        memoryPage.statusText = i18n("That is already remembered.");
                    }
                }
            }
        }

        QQC2.Label {
            Kirigami.FormData.label: ""
            visible: memoryPage.statusText.length > 0
            text: memoryPage.statusText
            wrapMode: Text.Wrap
            Layout.maximumWidth: Kirigami.Units.gridUnit * 24
            opacity: 0.7
        }

        QQC2.Label {
            Kirigami.FormData.label: i18n("Stored:")
            text: memoryPage.loaded
                  ? i18n("%1 of %2 pinned · %3 archived",
                         memoryPage.pinnedCount, MemoryStore.MAX_PINNED, memoryPage.archivedCount)
                  : i18n("Loading…")
        }

        QQC2.TextField {
            Kirigami.FormData.label: i18n("Filter:")
            Layout.preferredWidth: Kirigami.Units.gridUnit * 20
            visible: memoryPage.memories.length > 8
            placeholderText: i18n("Search saved memories…")
            onTextChanged: memoryPage.filterText = text
        }

        QQC2.ScrollView {
            Kirigami.FormData.label: ""
            Layout.preferredWidth: Kirigami.Units.gridUnit * 28
            Layout.preferredHeight: Kirigami.Units.gridUnit * 16
            visible: memoryPage.memories.length > 0

            ListView {
                id: memoryList
                clip: true
                model: memoryPage.visibleMemories()
                spacing: Kirigami.Units.smallSpacing

                delegate: Rectangle {
                    width: memoryList.width
                    height: memoryRow.implicitHeight + Kirigami.Units.smallSpacing * 2
                    color: index % 2 === 0 ? "transparent" : Kirigami.Theme.alternateBackgroundColor
                    radius: Kirigami.Units.smallSpacing

                    RowLayout {
                        id: memoryRow
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.margins: Kirigami.Units.smallSpacing

                        QQC2.CheckBox {
                            checked: modelData.pinned === true
                            QQC2.ToolTip.text: i18n("Keep this in the system prompt")
                            QQC2.ToolTip.visible: hovered
                            onToggled: {
                                var result = MemoryStore.setPinned(memoryPage.memories, modelData.id, checked);
                                if (result.changed) {
                                    memoryPage.memories = result.memories;
                                    memoryPage.statusText = "";
                                    persistMemories();
                                } else {
                                    // Put the box back; the model list is the truth.
                                    checked = modelData.pinned === true;
                                    if (result.reason === "pin_budget")
                                        memoryPage.statusText = i18n("Only %1 memories can be pinned at once. Unpin one first.",
                                                                     MemoryStore.MAX_PINNED);
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 0
                            QQC2.Label {
                                Layout.fillWidth: true
                                text: modelData.text
                                wrapMode: Text.Wrap
                            }
                            QQC2.Label {
                                Layout.fillWidth: true
                                text: {
                                    var bits = [modelData.id];
                                    if (modelData.created)
                                        bits.push(i18n("saved %1", modelData.created.split("T")[0]));
                                    if (modelData.tags && modelData.tags.length > 0)
                                        bits.push(modelData.tags.join(", "));
                                    // Deliberately not i18np: the Makefile's
                                    // xgettext call registers only i18n, so a
                                    // plural form would silently never reach
                                    // the .pot. "×N" sidesteps plurals.
                                    if (modelData.useCount > 0)
                                        bits.push(i18n("recalled %1×", modelData.useCount));
                                    return bits.join(" · ");
                                }
                                font: Kirigami.Theme.smallFont
                                wrapMode: Text.Wrap
                                opacity: 0.6
                            }
                        }

                        QQC2.ToolButton {
                            icon.name: "edit-delete"
                            QQC2.ToolTip.text: i18n("Forget this")
                            QQC2.ToolTip.visible: hovered
                            onClicked: {
                                var result = MemoryStore.removeMemory(memoryPage.memories, modelData.id);
                                if (result.removed) {
                                    memoryPage.memories = result.memories;
                                    persistMemories();
                                }
                            }
                        }
                    }
                }
            }
        }

        QQC2.Button {
            Kirigami.FormData.label: ""
            text: i18n("Forget everything")
            icon.name: "edit-clear-all"
            visible: memoryPage.memories.length > 0
            onClicked: confirmClear.open()
        }
    }

    QQC2.Dialog {
        id: confirmClear
        title: i18n("Forget everything?")
        modal: true
        anchors.centerIn: QQC2.Overlay.overlay
        standardButtons: QQC2.Dialog.Yes | QQC2.Dialog.Cancel

        QQC2.Label {
            text: i18n("This permanently deletes all saved memories, pinned and archived. It cannot be undone.")
            wrapMode: Text.Wrap
        }

        onAccepted: {
            memoryPage.memories = [];
            persistMemories();
        }
    }
}
