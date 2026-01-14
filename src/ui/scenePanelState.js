let $scenePanelContainer = null;
let $scenePanelContent = null;
let $sceneCollapseToggle = null;
let $sceneToolbar = null;
let $sceneRosterList = null;
let $sceneSectionsContainer = null;
let $sceneActiveCards = null;
let $sceneLiveLog = null;
let $sceneFooterButton = null;
let $sceneRosterSection = null;
let $sceneActiveSection = null;
let $sceneLogSection = null;
let $sceneStatusText = null;
let $sceneCoverageSection = null;
let $sceneCoveragePronouns = null;
let $sceneCoverageAttribution = null;
let $sceneCoverageAction = null;

export function setScenePanelContainer($element) {
    $scenePanelContainer = $element;
}

export function getScenePanelContainer() {
    return $scenePanelContainer;
}

export function setScenePanelContent($element) {
    $scenePanelContent = $element;
}

export function getScenePanelContent() {
    return $scenePanelContent;
}

export function setSceneSectionsContainer($element) {
    $sceneSectionsContainer = $element;
}

export function getSceneSectionsContainer() {
    return $sceneSectionsContainer;
}

export function setSceneCollapseToggle($element) {
    if ($element && typeof $element.length === "number" && $element.length === 0) {
        $sceneCollapseToggle = null;
        return;
    }
    $sceneCollapseToggle = $element || null;
}

export function getSceneCollapseToggle() {
    return $sceneCollapseToggle;
}

export function setSceneToolbar($element) {
    $sceneToolbar = $element;
}

export function getSceneToolbar() {
    return $sceneToolbar;
}

export function setSceneRosterList($element) {
    $sceneRosterList = $element;
}

export function getSceneRosterList() {
    return $sceneRosterList;
}

export function setSceneRosterSection($element) {
    $sceneRosterSection = $element;
}

export function getSceneRosterSection() {
    return $sceneRosterSection;
}

export function setSceneActiveCards($element) {
    $sceneActiveCards = $element;
}

export function getSceneActiveCards() {
    return $sceneActiveCards;
}

export function setSceneActiveSection($element) {
    $sceneActiveSection = $element;
}

export function getSceneActiveSection() {
    return $sceneActiveSection;
}

export function setSceneLiveLog($element) {
    $sceneLiveLog = $element;
}

export function getSceneLiveLog() {
    return $sceneLiveLog;
}

export function setSceneLiveLogSection($element) {
    $sceneLogSection = $element;
}

export function getSceneLiveLogSection() {
    return $sceneLogSection;
}

export function setSceneCoverageSection($element) {
    $sceneCoverageSection = $element;
}

export function getSceneCoverageSection() {
    return $sceneCoverageSection;
}

export function setSceneCoveragePronouns($element) {
    $sceneCoveragePronouns = $element;
}

export function getSceneCoveragePronouns() {
    return $sceneCoveragePronouns;
}

export function setSceneCoverageAttribution($element) {
    $sceneCoverageAttribution = $element;
}

export function getSceneCoverageAttribution() {
    return $sceneCoverageAttribution;
}

export function setSceneCoverageAction($element) {
    $sceneCoverageAction = $element;
}

export function getSceneCoverageAction() {
    return $sceneCoverageAction;
}

export function setSceneFooterButton($element) {
    $sceneFooterButton = $element;
}

export function getSceneFooterButton() {
    return $sceneFooterButton;
}

export function setSceneStatusText($element) {
    $sceneStatusText = $element;
}

export function getSceneStatusText() {
    return $sceneStatusText;
}
