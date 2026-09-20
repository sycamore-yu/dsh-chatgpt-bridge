/**
 * Reconcile Goal todos against structured tool facts.
 * Never scans assistant summary text.
 */
import { successfulKinds, } from './goal-facts.js';
const RELEASE_COMMIT = /\brelease\s+commit\b/i;
/**
 * Spans that name or quote an action instead of requesting it. Matching runs
 * on the text outside these spans, so `the error says "git push failed"` is a
 * reference to a string, not a push request.
 */
const QUOTED_SPAN = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/g;
/**
 * Prohibition and discussion cues (English + Chinese). A todo or Plan line
 * that forbids, negates, or merely discusses an action is not an action
 * request, so it gets no kind.
 *
 * Suppression is the fail-safe direction: an unclassified line can never be
 * promoted to completed by reconcileTodos (that path additionally requires a
 * matching successful tool fact) and can never be matched as the blocked or
 * deferred step. A keyword that only appears inside such wording therefore
 * cannot create or hide a control-plane state.
 */
const NOT_AN_ACTION = new RegExp([
    '\\b(?:do\\s+not|don\'t|does\\s+not|never|without|avoid|skip|refrain\\s+from|hold\\s+off|instead\\s+of)',
    '\\b(?:discuss(?:ed|ion)?|describe[sd]?|explain(?:s|ed)?|document(?:s|ed|ation)?|mentions?|reference[sd]?|quote[sd]?)',
    '不要|不准|不得|禁止|严禁|无需|无须|不必|避免|切勿|暂不|先不|别(?!的)',
    '讨论|说明|描述|引用|提及|文档|记录',
].join('|'), 'i');
function withoutQuotedSpans(text) {
    return text.replace(QUOTED_SPAN, ' ');
}
/**
 * Map a todo line onto at most one action kind using an explicit lexicon.
 * Unmatched lines stay untouched later. The lexicon deliberately refuses
 * negation, discussion and quoted-reference wording, because this label feeds
 * the blocked / deferred / completed reporting paths.
 */
export function classifyTodoKind(content) {
    const text = withoutQuotedSpans(content).toLowerCase();
    if (text.trim() === '' || NOT_AN_ACTION.test(text))
        return undefined;
    if (/\bnpm\b/.test(text) && /\bpublish\b/.test(text))
        return 'npm_publish';
    if (/\bpublish\b/.test(text) && !RELEASE_COMMIT.test(text))
        return 'npm_publish';
    if (/\btag\b/.test(text))
        return 'git_tag';
    if (/\bpush\b/.test(text))
        return 'git_push';
    if (/\bgithub\s+release\b/.test(text) || /\bgh\s+release\b/.test(text))
        return 'github_release';
    if (/\brelease\b/.test(text) && !RELEASE_COMMIT.test(text) && !/\bpush\b/.test(text)) {
        return 'github_release';
    }
    return undefined;
}
function waitingSet(input) {
    return {
        kinds: new Set(input.waitingKinds ?? []),
        contents: new Set(input.waitingContents ?? []),
    };
}
function isWaitingTodo(todo, kind, waiting) {
    if (waiting.contents.has(todo.content))
        return true;
    if (kind !== undefined && waiting.kinds.has(kind))
        return true;
    return false;
}
/**
 * Overlay reconciled statuses onto the last todo/write snapshot.
 * Agent-authored `completed` is never rolled back.
 */
export function reconcileTodos(input) {
    const todos = input.todos ?? input.facts.todos;
    if (todos === undefined)
        return undefined;
    const succeeded = successfulKinds(input.facts);
    const waiting = waitingSet(input);
    const usedKinds = new Set();
    const holdAny = input.holdInProgress === true && waiting.kinds.size === 0 && waiting.contents.size === 0;
    let promoted = false;
    return todos.map((todo) => {
        if (todo.status === 'completed')
            return todo;
        const kind = classifyTodoKind(todo.content);
        const holdThis = isWaitingTodo(todo, kind, waiting) || (holdAny && !promoted);
        if (holdThis) {
            promoted = true;
            return todo.status === 'in_progress' ? todo : { ...todo, status: 'in_progress' };
        }
        if (kind === undefined || !succeeded.has(kind) || usedKinds.has(kind))
            return todo;
        usedKinds.add(kind);
        return { ...todo, status: 'completed' };
    });
}
