/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

import "voiceProfiles.js" as VoiceProfiles

// Voice profile chooser shared by the Speech to Text and Text to Speech pages.
// A profile is a named set of the settings on both pages. Switching saves what
// the page holds into the profile being left, then puts the chosen profile's
// settings on the page; Apply saves them, Cancel throws the switch away. The
// rules are in voiceProfiles.js; this only shows them.
ColumnLayout {
    id: bar

    // The settings page: an object with cfg_<name> properties. It may define
    // _applyingVoiceProfile (set while values are being put on the page).
    property var page

    // The page's values were replaced; it should refresh its own boxes.
    signal applied()

    readonly property var profiles: VoiceProfiles.load(page ? page.cfg_voiceProfiles : "")
    readonly property string activeId: page ? (page.cfg_activeVoiceProfileId || "") : ""
    readonly property var active: VoiceProfiles.getActive(profiles, activeId)
    readonly property bool activeIsBuiltIn: !!active && VoiceProfiles.isBuiltIn(active)

    // "new", "copy" or "rename": what the name box in the dialog is for.
    property string _nameMode: ""

    spacing: Kirigami.Units.smallSpacing

    function label(profile) {
        return profile.builtIn ? i18n("Local only") : profile.name;
    }

    function labels() {
        return bar.profiles.map(function(p) { return bar.label(p); });
    }

    function syncCombo() {
        var idx = -1;
        for (var i = 0; i < bar.profiles.length; i++) {
            if (bar.active && bar.profiles[i].id === bar.active.id) {
                idx = i;
                break;
            }
        }
        if (profileCombo.currentIndex !== idx)
            profileCombo.currentIndex = idx;
    }

    // Later, so the combo has taken its new model first.
    onProfilesChanged: Qt.callLater(syncCombo)
    onActiveIdChanged: Qt.callLater(syncCombo)

    // First use: "My setup" from the current settings, plus "Local only".
    function init() {
        if (!page)
            return;
        var res = VoiceProfiles.ensureDefaults(page.cfg_voiceProfiles, page.cfg_activeVoiceProfileId, page);
        if (res.changed) {
            page.cfg_voiceProfiles = VoiceProfiles.serialize(res.profiles);
            page.cfg_activeVoiceProfileId = res.activeId;
        }
        syncCombo();
    }

    Component.onCompleted: Qt.callLater(init)

    // The profile list with the active profile holding what the page has now.
    function _listWithPageValues() {
        return VoiceProfiles.saveActive(bar.profiles, bar.activeId, page);
    }

    function _put(list, id) {
        page.cfg_voiceProfiles = VoiceProfiles.serialize(list);
        page.cfg_activeVoiceProfileId = id;
    }

    // Put a profile's settings on the page, then let the page refresh.
    function _apply(profile) {
        page._applyingVoiceProfile = true;
        VoiceProfiles.applyToPage(profile, page);
        page._applyingVoiceProfile = false;
        bar.applied();
    }

    function switchTo(id) {
        if (!page)
            return;
        if (id === bar.activeId) {
            syncCombo();
            return;
        }
        page._applyingVoiceProfile = true;
        var res = VoiceProfiles.switchTo(bar.profiles, bar.activeId, id, page);
        page._applyingVoiceProfile = false;
        _put(res.profiles, res.activeId);
        bar.applied();
        syncCombo();
    }

    // Called by the page when the dialog saves: the active profile keeps
    // whatever was edited since the switch.
    function saveActiveProfile() {
        if (!page || !bar.active)
            return;
        _put(_listWithPageValues(), bar.active.id);
    }

    function createProfile(name) {
        var list = _listWithPageValues();
        var res = VoiceProfiles.createProfile(list, name, page);
        _put(res.profiles, res.profile.id);
    }

    function copyProfile(name) {
        var list = _listWithPageValues();
        var res = VoiceProfiles.duplicate(list, bar.activeId, name);
        if (res.profile)
            _put(res.profiles, res.profile.id);
    }

    function renameProfile(name) {
        var list = _listWithPageValues();
        var res = VoiceProfiles.rename(list, bar.activeId, name);
        _put(res.profiles, bar.activeId);
    }

    function deleteProfile() {
        var list = _listWithPageValues();
        var res = VoiceProfiles.remove(list, bar.activeId, bar.activeId);
        if (!res.removed)
            return;
        _put(res.profiles, res.activeId);
        _apply(VoiceProfiles.find(res.profiles, res.activeId));
    }

    function resetBuiltIn() {
        var list = _listWithPageValues();
        var res = VoiceProfiles.resetProfile(list, bar.activeId);
        if (!res.reset)
            return;
        _put(res.profiles, bar.activeId);
        _apply(VoiceProfiles.find(res.profiles, bar.activeId));
    }

    function askName(mode) {
        bar._nameMode = mode;
        if (mode === "rename")
            nameField.text = bar.active ? bar.label(bar.active) : "";
        else if (mode === "copy")
            nameField.text = bar.active ? i18n("%1 copy", bar.label(bar.active)) : "";
        else
            nameField.text = "";
        nameDialog.open();
        nameField.forceActiveFocus();
        nameField.selectAll();
    }

    RowLayout {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 28
        spacing: Kirigami.Units.smallSpacing

        QQC2.ComboBox {
            id: profileCombo
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            model: bar.labels()
            onActivated: function(index) {
                var p = bar.profiles[index];
                if (p)
                    bar.switchTo(p.id);
            }
        }

        QQC2.ToolButton {
            id: menuButton
            icon.name: "application-menu"
            onClicked: profileMenu.popup(menuButton, 0, menuButton.height)
            QQC2.ToolTip.text: i18n("Voice profile actions")
            QQC2.ToolTip.visible: hovered
            QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
            Accessible.name: i18n("Voice profile actions")

            QQC2.Menu {
                id: profileMenu

                QQC2.MenuItem {
                    text: i18n("New profile…")
                    icon.name: "document-new"
                    onTriggered: bar.askName("new")
                }
                QQC2.MenuItem {
                    text: i18n("Copy profile…")
                    icon.name: "edit-copy"
                    onTriggered: bar.askName("copy")
                }
                QQC2.MenuItem {
                    text: i18n("Rename…")
                    icon.name: "edit-rename"
                    enabled: !bar.activeIsBuiltIn
                    onTriggered: bar.askName("rename")
                }
                QQC2.MenuItem {
                    text: i18n("Delete")
                    icon.name: "edit-delete"
                    enabled: !bar.activeIsBuiltIn && bar.profiles.length > 1
                    onTriggered: deleteDialog.open()
                }
                QQC2.MenuSeparator {
                    visible: bar.activeIsBuiltIn
                }
                QQC2.MenuItem {
                    text: i18n("Reset to built-in")
                    icon.name: "edit-undo"
                    visible: bar.activeIsBuiltIn
                    height: visible ? implicitHeight : 0
                    onTriggered: bar.resetBuiltIn()
                }
            }
        }
    }

    QQC2.Label {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 28
        wrapMode: Text.WordWrap
        font: Kirigami.Theme.smallFont
        opacity: 0.75
        text: i18n("Switching saves your current speech settings into the profile you're leaving.")
    }

    QQC2.Label {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 28
        visible: bar.activeIsBuiltIn
        wrapMode: Text.WordWrap
        font: Kirigami.Theme.smallFont
        opacity: 0.75
        text: i18n("Local only uses speech programs on this computer for both listening and speaking.")
    }

    Kirigami.PromptDialog {
        id: nameDialog
        title: bar._nameMode === "rename" ? i18n("Rename voice profile")
            : bar._nameMode === "copy" ? i18n("Copy voice profile")
            : i18n("New voice profile")
        subtitle: bar._nameMode === "new"
            ? i18n("The new profile starts with your current speech settings.")
            : ""
        standardButtons: Kirigami.Dialog.Ok | Kirigami.Dialog.Cancel

        onAccepted: {
            var name = nameField.text.replace(/^\s+|\s+$/g, "");
            if (!name.length)
                return;
            if (bar._nameMode === "rename")
                bar.renameProfile(name);
            else if (bar._nameMode === "copy")
                bar.copyProfile(name);
            else
                bar.createProfile(name);
        }

        QQC2.TextField {
            id: nameField
            placeholderText: i18n("Profile name")
            onAccepted: nameDialog.accept()
        }
    }

    Kirigami.PromptDialog {
        id: deleteDialog
        title: i18n("Delete voice profile")
        subtitle: bar.active
            ? i18n("Delete “%1”? Its speech settings are removed; the settings on this page switch to another profile.", bar.label(bar.active))
            : ""
        standardButtons: Kirigami.Dialog.Ok | Kirigami.Dialog.Cancel
        onAccepted: bar.deleteProfile()
    }
}
