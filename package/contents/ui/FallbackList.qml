/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

import "fallbacks.js" as Fallbacks

// The "Fallbacks" list on a speech page: backends tried in order when the main
// one fails. The page works out the rows (which are set up) and the choices
// that can still be added, and saves what listChanged reports; the rules for
// adding, removing and moving live in fallbacks.js.
ColumnLayout {
    id: root

    // The saved list (JSON text) and the main backend's id.
    property string listJson: "[]"
    property string mainId: ""
    // Every backend id the page knows about.
    property var knownIds: []
    // [{id, name, setUp, first, last}] for the saved list, in order.
    property var rows: []
    // [{id, name}] for the backends that can still be added.
    property var choices: []
    // What the list is for, in the page's words ("speech output", "speech input").
    property string purpose: ""

    signal listChanged(string json)

    function _list() {
        return Fallbacks.parseList(root.listJson, root.mainId, root.knownIds);
    }

    function addBackend(id) {
        root.listChanged(Fallbacks.serialize(Fallbacks.addFallback(_list(), root.mainId, id, root.knownIds)));
    }

    function removeBackend(id) {
        root.listChanged(Fallbacks.serialize(Fallbacks.removeFallback(_list(), id)));
    }

    function moveBackend(id, delta) {
        root.listChanged(Fallbacks.serialize(Fallbacks.moveFallback(_list(), id, delta)));
    }

    spacing: Kirigami.Units.smallSpacing

    QQC2.Label {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 28
        wrapMode: Text.WordWrap
        font: Kirigami.Theme.smallFont
        opacity: 0.75
        text: root.purpose
    }

    QQC2.Label {
        Layout.fillWidth: true
        visible: root.rows.length === 0
        wrapMode: Text.WordWrap
        font: Kirigami.Theme.smallFont
        opacity: 0.75
        text: i18n("No fallbacks. If the main backend fails, the error is shown.")
    }

    Repeater {
        model: root.rows

        delegate: RowLayout {
            id: rowItem
            required property var modelData
            required property int index

            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 28
            spacing: Kirigami.Units.smallSpacing

            QQC2.Label {
                Layout.fillWidth: true
                text: (rowItem.index + 1) + ". " + rowItem.modelData.name
                elide: Text.ElideRight
                opacity: rowItem.modelData.setUp ? 1.0 : 0.7
            }

            QQC2.Label {
                visible: !rowItem.modelData.setUp
                text: i18n("not set up")
                font: Kirigami.Theme.smallFont
                color: Kirigami.Theme.neutralTextColor
            }

            QQC2.ToolButton {
                icon.name: "go-up"
                enabled: !rowItem.modelData.first
                onClicked: root.moveBackend(rowItem.modelData.id, -1)
                QQC2.ToolTip.text: i18n("Try earlier")
                QQC2.ToolTip.visible: hovered
                QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                Accessible.name: i18n("Try earlier")
            }

            QQC2.ToolButton {
                icon.name: "go-down"
                enabled: !rowItem.modelData.last
                onClicked: root.moveBackend(rowItem.modelData.id, 1)
                QQC2.ToolTip.text: i18n("Try later")
                QQC2.ToolTip.visible: hovered
                QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                Accessible.name: i18n("Try later")
            }

            QQC2.ToolButton {
                icon.name: "list-remove"
                onClicked: root.removeBackend(rowItem.modelData.id)
                QQC2.ToolTip.text: i18n("Remove from the list")
                QQC2.ToolTip.visible: hovered
                QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                Accessible.name: i18n("Remove from the list")
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 28
        visible: root.choices.length > 0
        spacing: Kirigami.Units.smallSpacing

        QQC2.ComboBox {
            id: addCombo
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            model: root.choices.map(function(c) { return c.name; })
        }

        QQC2.Button {
            icon.name: "list-add"
            text: i18n("Add")
            enabled: addCombo.currentIndex >= 0 && addCombo.currentIndex < root.choices.length
            onClicked: {
                var pick = root.choices[addCombo.currentIndex];
                if (pick)
                    root.addBackend(pick.id);
                addCombo.currentIndex = 0;
            }
        }
    }
}
