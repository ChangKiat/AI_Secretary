/** Recognize older meal-selection questions even after the in-memory chat expires. */
export function isReceiptMealQuestion(text: string): boolean {
    if (/which items are yours\?/i.test(text)) return true;
    const hasItems = /\breceipt\b|^\s*\d+[.)]\s+/im.test(text);
    const asksOwnership = /\b(?:which|what)\b[^?\n]*(?:yours|you\s+(?:ate|eat|had))|\b(?:is|are)\s+(?:this|these|it|they)\s+yours\b|\b(?:did you share|how many people|shared?\s+(?:it|them|with))\b/i.test(text);
    return hasItems && asksOwnership;
}
