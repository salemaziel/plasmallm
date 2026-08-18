/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

var name = "recall";
var displayName = "Recall Memory";
var description = "Search long-term memory for saved facts that are not in your system prompt. The Memory section lists only the pinned facts; everything else is archived and found through this tool. Call it whenever the user refers to a person, machine, project, or preference you do not already have in context. Use a few distinctive keywords rather than a full sentence.";
var parameters = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "Keywords to search for, e.g. 'printer model' or 'work laptop hostname'. Matching is by word overlap, so distinctive nouns work far better than a conversational question."
        }
    },
    required: ["query"]
};

var sandboxed = false;
// Reads local data the user already owns and changes nothing they can observe,
// so it needs no justification argument and no approval card — same treatment
// as restore_context.
var sideEffect = false;
var uiHidden = true;

function execute(args, context) {
    if (!context.memory || typeof context.memory.search !== "function") {
        context.error("Memory is not available.");
        return;
    }
    if (!context.config || !context.config.memoryEnabled) {
        context.onDone("Memory is disabled in settings; there is nothing to search.", "", 0);
        return;
    }

    var query = String(args.query || "").trim();
    if (query.length === 0) {
        context.onDone("", "A query is required to search memory.", 1);
        return;
    }

    var result = context.memory.search(query);
    context.onDone(result.text, "", 0);
}
