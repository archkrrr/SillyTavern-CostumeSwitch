import {
    VERB_CATALOG,
    buildLegacyVerbList,
    buildVerbSlices,
} from "./src/data/verbCatalog.js";

const defaultAttributionSlices = buildVerbSlices({ category: "attribution", edition: "default" });
const extendedAttributionSlices = buildVerbSlices({ category: "attribution", edition: "extended" });
const defaultActionSlices = buildVerbSlices({ category: "action", edition: "default" });
const extendedActionSlices = buildVerbSlices({ category: "action", edition: "extended" });

export const DEFAULT_ATTRIBUTION_VERBS = buildLegacyVerbList({ category: "attribution", edition: "default" });
export const DEFAULT_ATTRIBUTION_VERBS_PRESENT = defaultAttributionSlices.base;
export const DEFAULT_ATTRIBUTION_VERBS_THIRD_PERSON = defaultAttributionSlices.thirdPerson;
export const DEFAULT_ATTRIBUTION_VERBS_PAST = defaultAttributionSlices.past;
export const DEFAULT_ATTRIBUTION_VERBS_PAST_PARTICIPLE = defaultAttributionSlices.pastParticiple;
export const DEFAULT_ATTRIBUTION_VERBS_PRESENT_PARTICIPLE = defaultAttributionSlices.presentParticiple;

export const EXTENDED_ATTRIBUTION_VERBS = buildLegacyVerbList({ category: "attribution", edition: "extended" });
export const EXTENDED_ATTRIBUTION_VERBS_PRESENT = extendedAttributionSlices.base;
export const EXTENDED_ATTRIBUTION_VERBS_THIRD_PERSON = extendedAttributionSlices.thirdPerson;
export const EXTENDED_ATTRIBUTION_VERBS_PAST = extendedAttributionSlices.past;
export const EXTENDED_ATTRIBUTION_VERBS_PAST_PARTICIPLE = extendedAttributionSlices.pastParticiple;
export const EXTENDED_ATTRIBUTION_VERBS_PRESENT_PARTICIPLE = extendedAttributionSlices.presentParticiple;

export const DEFAULT_ACTION_VERBS = buildLegacyVerbList({ category: "action", edition: "default" });
export const DEFAULT_ACTION_VERBS_PRESENT = defaultActionSlices.base;
export const DEFAULT_ACTION_VERBS_THIRD_PERSON = defaultActionSlices.thirdPerson;
export const DEFAULT_ACTION_VERBS_PAST = defaultActionSlices.past;
export const DEFAULT_ACTION_VERBS_PAST_PARTICIPLE = defaultActionSlices.pastParticiple;
export const DEFAULT_ACTION_VERBS_PRESENT_PARTICIPLE = defaultActionSlices.presentParticiple;

export const EXTENDED_ACTION_VERBS = buildLegacyVerbList({ category: "action", edition: "extended" });
export const EXTENDED_ACTION_VERBS_PRESENT = extendedActionSlices.base;
export const EXTENDED_ACTION_VERBS_THIRD_PERSON = extendedActionSlices.thirdPerson;
export const EXTENDED_ACTION_VERBS_PAST = extendedActionSlices.past;
export const EXTENDED_ACTION_VERBS_PAST_PARTICIPLE = extendedActionSlices.pastParticiple;
export const EXTENDED_ACTION_VERBS_PRESENT_PARTICIPLE = extendedActionSlices.presentParticiple;

export {
    VERB_CATALOG,
    buildLegacyVerbList,
    buildVerbSlices,
};
