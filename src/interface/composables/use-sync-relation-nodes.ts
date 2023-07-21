import { useM2aStore } from "./use-m2a-store";

import type { ShallowRef } from "vue";
import type { RelationReference } from "../types/relation-reference";
import type { Editor } from "@tiptap/vue-3";
import type { Item } from "@directus/types";
import type { UUID } from "../types/relation-nodes";
import type { M2AStoreItem } from "./use-m2a-store";
import type { NodeWithPos } from "@tiptap/vue-3";
import {
    Node as ProseMirrorNodeOriginal,
    Attrs as ProseMirrorAttrs,
} from "@tiptap/pm/model";

type ProseMirrorNode = ProseMirrorNodeOriginal & {
    // remove readonly
    attrs: ProseMirrorAttrs;
};

type SyncRelationNodesAttributes = {
    m2aRelation: RelationReference;
    editor: ShallowRef<Editor | undefined>;
    editorField: string | null;
};

export function useSyncRelationNodes({
    m2aRelation,
    editor,
    editorField,
}: SyncRelationNodesAttributes) {
    const m2aStore = useM2aStore();

    return {
        initFetchedItems,
        syncRelationNodes() {
            const editorNodes = _getExistingEditorNodes();
            syncRemovedNodes(editorNodes);
            syncInsertedNodes(editorNodes);
        },
    };

    function initFetchedItems(fetchedItems: Item[]) {
        if (!m2aStore.initialized(fetchedItems))
            m2aStore.init(fetchedItems, m2aRelation.junctionPrimaryKeyField);

        // First add all fetchedItems to M2A Store, then set the editor fields per editor

        const editorNodeIds: UUID[] = _getExistingEditorNodes().map(
            ({ node }) => node.attrs.id
        );

        m2aStore.setEditorFields(editorNodeIds, editorField);
    }

    function syncInsertedNodes(editorNodes: NodeWithPos[]) {
        const memory = _nodeIdMemory();

        // TODO: [Stage 2][flow chart] Place link to flow chart here
        editorNodes.forEach(({ node, pos }) => {
            let nodeId = node.attrs.id;

            // NodeId does not exist in M2A store and the NodeView component will display a warning because the related item is missing
            if (!m2aStore.itemExists(nodeId)) return;

            const storeItemIsActive = m2aStore.itemIsActive(nodeId);
            const nodeIdIsUnique = memory.nodeIdUniqueInEditor(nodeId);
            const nodeFromDifferentEditor = m2aStore.itemFromDifferentEditor(
                nodeId,
                editorField
            );

            // Nothing changed OR inserted a new node OR dragged and dropped an existing node
            if (storeItemIsActive && nodeIdIsUnique && !nodeFromDifferentEditor)
                return;

            if (storeItemIsActive) {
                nodeId = m2aStore.duplicateItem(nodeId, m2aRelation);
                _refreshEditorNodeId(nodeId, node, pos);
                memory.replaceLastItem(nodeId);
            } else {
                m2aStore.activateItem(nodeId);
            }

            if (nodeFromDifferentEditor) m2aStore.setField(nodeId, editorField);

            const storeItemReactivated = !storeItemIsActive;
            const storeItemNotNew = !m2aStore.itemIsNew(nodeId);
            const storeItem = m2aStore.getItem(nodeId)!;

            if (storeItemNotNew && storeItemReactivated) {
                // TODO: [simplify] can we add the $index,$type fields while updating to the m2aStore? then this would be much simpler
                _reactivateRelatedItem(nodeId);

                if (storeItem.edits) {
                    _mergeUpdatedValues(storeItem, nodeId);
                    m2aRelation.update(storeItem.edits as Item[]);
                }

                return;
            }

            m2aRelation.create(storeItem.item);
        });
    }

    function _nodeIdMemory() {
        return {
            nodeIds: [] as UUID[],
            nodeIdUniqueInEditor(nodeId: UUID) {
                const isUnique = this.nodeIds.indexOf(nodeId) < 0;
                this.nodeIds.push(nodeId);
                return isUnique;
            },
            replaceLastItem(nodeId: UUID) {
                this.nodeIds.splice(this.nodeIds.length - 1, 1, nodeId);
            },
        };
    }

    function _getExistingEditorNodes() {
        const editorNodes: NodeWithPos[] = [];

        editor.value!.state.doc.descendants((node, pos) => {
            if (node.type.name === "relation-block")
                editorNodes.push({ node, pos });
        });

        return editorNodes;
    }

    function _refreshEditorNodeId(
        nodeId: UUID,
        node: ProseMirrorNode,
        pos: number
    ) {
        _updateNodeAttrs(node, pos, { ...node.attrs, id: nodeId });
    }

    function _updateNodeAttrs(
        node: ProseMirrorNode,
        pos: number,
        updatedAttrs: ProseMirrorAttrs
    ) {
        const transaction = editor.value!.state.tr;

        transaction.setNodeMarkup(pos, undefined, updatedAttrs);

        // Update the editor content without triggering an update
        transaction.setMeta("addToHistory", false);
        transaction.setMeta("preventUpdate", true);

        // Apply changes
        editor.value!.view.dispatch(transaction);

        // needs to be set after `setNodeMarkup`
        node.attrs = updatedAttrs;
    }

    function _mergeUpdatedValues(storeItem: M2AStoreItem, nodeId: UUID) {
        const item = m2aRelation.findDisplayItem(nodeId);
        if (!item) return;

        const { $type, $index, $edits } = item;
        storeItem.edits = {
            ...(storeItem.edits as Item),
            $type,
            $index,
            $edits,
        };
    }

    function _reactivateRelatedItem(nodeId: UUID) {
        const relatedItem = m2aRelation.findDisplayItem(nodeId)!;
        // `remove` reactivates a previously removed item
        m2aRelation.remove(relatedItem);
    }

    function syncRemovedNodes(editorNodes: NodeWithPos[]) {
        const existingNodeIds = editorNodes.map(({ node }) => node.attrs.id);
        const inactiveNodeIds = m2aStore.deactivateUnusedItems(
            existingNodeIds,
            editorField
        );
        _removeRelatedItems(inactiveNodeIds);
    }

    function _removeRelatedItems(nodeIds: UUID[]) {
        if (!nodeIds.length) return;

        nodeIds.forEach((nodeId) => {
            const relatedItem = m2aRelation.findDisplayItem(nodeId);
            if (!relatedItem) return;
            m2aRelation.deleteItem(relatedItem);
        });
    }
}
