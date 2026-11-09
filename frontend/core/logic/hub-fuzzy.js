/* === HapsHub: search that forgives typos and decorated names. === */

// Lookalike letters people use in display names that Unicode doesn't fold by itself.
const _HUB_LOOKALIKES = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
    'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
    'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe',
};

/** Folds a name to plain lower-case letters and digits, so "Ｍｉｚｕｋｉ ♡" and "mizuki" are the same. */
function hubSearchFold(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/./gu, ch => _HUB_LOOKALIKES[ch] ?? ch)
        .replace(/[^\p{L}\p{N}]/gu, '');
}

/** The fewest edits (a wrong, extra, missing or swapped letter) that turn the query into part of the text. */
function _hubEditsToSomePart(text, query, limit) {
    let before = null;
    let previous = new Array(query.length + 1);
    for (let j = 0; j <= query.length; j++) previous[j] = j;
    let best = previous[query.length];
    for (let i = 1; i <= text.length; i++) {
        const current = new Array(query.length + 1);
        current[0] = 0; // A match may start anywhere in the text.
        for (let j = 1; j <= query.length; j++) {
            const same = text[i - 1] === query[j - 1];
            let cost = Math.min(previous[j - 1] + (same ? 0 : 1), previous[j] + 1, current[j - 1] + 1);
            if (before && j > 1 && i > 1 && text[i - 1] === query[j - 2] && text[i - 2] === query[j - 1]) cost = Math.min(cost, before[j - 2] + 1);
            current[j] = cost;
        }
        best = Math.min(best, current[query.length]);
        if (best === 0) return 0;
        before = previous;
        previous = current;
    }
    return best <= limit ? best : limit + 1;
}

/** 0 for a plain match, 1 for a near one, -1 for none. Short queries must match exactly, or everything would. */
function hubSearchScore(text, query) {
    const q = hubSearchFold(query);
    const name = hubSearchFold(text);
    if (!q || !name) return -1;
    if (name.includes(q)) return 0;
    if (q.length < 3) return -1;
    const allowed = q.length < 6 ? 1 : 2;
    return _hubEditsToSomePart(name, q, allowed) <= allowed ? 1 : -1;
}

function hubSearchMatches(text, query) {
    return hubSearchScore(text, query) >= 0;
}

/** A friend matches on either of their names, or their exact ID. */
function hubFriendMatches(friend, query) {
    return hubSearchMatches(friend.displayName, query)
        || hubSearchMatches(friend.username || friend.userName, query)
        || (friend.id || '').toLowerCase().includes(String(query).toLowerCase());
}
