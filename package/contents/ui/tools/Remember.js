/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

var name = "remember";
var description = "Save a durable fact about the user, their system, or their preferences so it is available in future conversations. Use it for things that stay true (names, hardware, workflows, standing preferences), not for details that only matter in this chat. One fact per call, written as a short self-contained statement.";
var parameters = {
    type: "object",
    properties: {
        text: {
            type: "string",
            description: "The fact to remember, as one short self-contained sentence. It will be shown to you out of context in later conversations, so avoid pronouns like 'it' or 'that' and avoid references to the current chat."
        },
        tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional. One to five short topic words, e.g. ['hardware','printer']. Tags make the fact easier to find later with the recall tool and are listed in your system prompt as an index of what is stored."
        },
        pin: {
            type: "boolean",
            description: "Optional. True keeps this fact in your system prompt permanently instead of leaving it to be searched with recall. The pinned budget is small, so reserve it for facts relevant to almost every conversation (who the user is, their main machine, standing preferences). Omit for anything narrower."
        },
        justification: {
            type: "string",
            description: "A brief 1 sentence justification for why this is worth remembering long-term."
        }
    },
    required: ["text", "justification"]
};
var sandboxed = false;
// Writes to persistent storage the user can inspect and delete, so it is
// surfaced in the UI like any other state-changing tool.
var sideEffect = true;

function execute(args, context) {
    if (!context.memory) {
        context.error("Memory is not available.");
        return;
    }
    if (!context.config || !context.config.memoryEnabled) {
        context.onDone("Memory is disabled in settings; nothing was saved.", "", 0);
        return;
    }

    var result = context.memory.add(args.text, {
        pinned: (args.pin === true) ? true : undefined,
        tags: args.tags
    });

    if (!result.added) {
        if (result.reason === "duplicate") {
            context.onDone("Already remembered [" + result.id + "]; nothing changed.", "", 0);
        } else {
            context.onDone("", "Nothing to remember: the text was empty.", 1);
        }
        return;
    }

    // Say which tier it landed in. The model needs to know whether it will see
    // this fact automatically next time or has to call recall to find it.
    var where = result.pinned
        ? "Remembered [" + result.id + "] and pinned to your system prompt: "
        : "Remembered [" + result.id + "] in the searchable archive (find it later with recall): ";
    var note = "";
    if (result.reason === "pin_budget") {
        note = "\nThe pinned set is full, so this was archived instead. Ask the user to unpin something in Memory settings if it truly belongs in every conversation.";
    }
    context.onDone(where + result.text + note, "", 0);
}
