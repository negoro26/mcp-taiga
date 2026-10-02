import { defineRule } from "@oxlint/plugins";

export const noCommentsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow comments in source files; carry meaning in names and types, and record intent in FEATURES.md.",
		},
		messages: {
			noComment:
				"Comments are banned. Rename so the code states the intent, and document the reasoning in FEATURES.md.",
		},
	},
	create(context) {
		const source = context.sourceCode.getText();
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (comment.range[0] === 0 && source.startsWith("#!")) continue;
					context.report({ node: comment, messageId: "noComment" });
				}
			},
		};
	},
});
