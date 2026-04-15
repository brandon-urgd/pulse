// Feature: two-phase-session-start
// Template greeting strings for Pulse session opening messages.
// Used by ExtractText, CreateItem, and UpdateItem Lambdas.

/**
 * Greeting templates keyed by item type.
 * Each template contains a `{itemName}` placeholder to be replaced at storage time.
 */
export const GREETING_TEMPLATES = {
  document: "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through {itemName}. When you're ready, just let me know and I'll take a moment to review the material before we dive in.",
  image: "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through {itemName} with you. When you're ready, just let me know and I'll take a closer look before we get started.",
}

/**
 * Builds a greeting string for the given item type and name.
 * Selects the image template when `itemType` is `'image'`;
 * falls back to the document template for all other types.
 *
 * @param {string} itemType - The item's type (e.g. 'image', 'document', 'markdown')
 * @param {string} itemName - The item's display name, injected into the template
 * @returns {string} The greeting with `{itemName}` replaced
 */
export function buildTemplateGreeting(itemType, itemName) {
  const template = itemType === 'image' ? GREETING_TEMPLATES.image : GREETING_TEMPLATES.document
  return template.replace('{itemName}', itemName)
}
