/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

.import "../memoryStore.js" as MemoryStore

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
        replaces: {
            type: "string",
            description: "Optional. The id (for example m_k3f9x2ab) or a distinctive phrase from an existing memory that this text corrects. Use it whenever a saved fact has changed rather than calling forget and then remember — replacing keeps the entry's id, its pinned state and how often it has been useful. The phrase must match only one memory."
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

    // A correction rewrites the existing entry rather than minting a new one,
    // so its id, pinned state and use history survive being right the second
    // time. Failures here are reported instead of silently falling through to
    // an add, which would leave the stale fact in place beside the new one.
    if (args.replaces !== undefined && args.replaces !== null && String(args.replaces).length > 0) {
        if (typeof context.memory.update !== "function") {
            context.error("This build cannot replace memories.");
            return;
        }
        var upd = context.memory.update(args.replaces, args.text);
        if (upd.updated) {
            context.onDone("Updated [" + upd.id + "]: \"" + upd.oldText + "\" is now \"" + upd.text + "\"", "", 0);
            return;
        }
        if (upd.reason === "ambiguous") {
            context.onDone("",
                "'" + args.replaces + "' matches " + upd.matches.length
                + " saved memories. Call remember again with one of these ids in replaces:\n"
                + MemoryStore.formatCandidates(upd.matches), 1);
            return;
        }
        if (upd.reason === "unchanged") {
            context.onDone("Already remembered [" + upd.id + "] with that wording; nothing changed.", "", 0);
            return;
        }
        if (upd.reason === "duplicate") {
            context.onDone("", "That wording is already saved as [" + upd.id + "]. Forget one of the two instead.", 1);
            return;
        }
        if (upd.reason === "pin_budget") {
            context.onDone("", "The rewritten fact no longer fits the pinned budget. Ask the user to unpin something in Memory settings, or shorten it.", 1);
            return;
        }
        if (upd.reason === "not_found") {
            context.onDone("", "No memory matched '" + args.replaces + "'. Call recall to find its id, or omit replaces to save this as a new fact.", 1);
            return;
        }
        context.onDone("", "Nothing to remember: the text was empty.", 1);
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
