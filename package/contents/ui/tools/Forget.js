/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

var name = "forget";
var description = "Delete a saved memory, by the id shown in the Memory section of your system prompt or by a distinctive phrase from its text. Use it when a remembered fact is wrong, has been superseded, or the user asks you to forget something.";
var parameters = {
    type: "object",
    properties: {
        target: {
            type: "string",
            description: "The memory id (for example m_k3f9x2ab) or a distinctive phrase from the memory's text."
        },
        justification: {
            type: "string",
            description: "A brief 1 sentence justification for why this memory should be removed."
        }
    },
    required: ["target", "justification"]
};
var sandboxed = false;
var sideEffect = true;

function execute(args, context) {
    if (!context.memory) {
        context.error("Memory is not available.");
        return;
    }

    var result = context.memory.remove(args.target);

    if (result.removed) {
        context.onDone("Forgot: " + result.text, "", 0);
    } else {
        context.onDone("", "No memory matched '" + args.target + "'.", 1);
    }
}
