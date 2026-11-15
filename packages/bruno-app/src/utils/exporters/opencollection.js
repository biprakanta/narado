import jsyaml from 'js-yaml';
import { brunoToOpenCollection } from '@usebruno/converters';
import { filterTransientItems } from 'utils/collections';
import { isNarado } from 'utils/common/product';

export const exportCollection = (collection, version) => {
  // Filter out transient items before export
  collection.items = filterTransientItems(collection.items);

  const openCollection = brunoToOpenCollection(collection);

  if (!openCollection.extensions) {
    openCollection.extensions = {};
  }
  if (!openCollection.extensions.bruno) {
    openCollection.extensions.bruno = {};
  }
  openCollection.extensions.bruno.exportedAt = new Date().toISOString();
  openCollection.extensions.bruno.exportedUsing = isNarado() ? `narado (Bruno/${version || '?'})` : version ? `Bruno/${version}` : 'Bruno';

  return jsyaml.dump(openCollection, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });
};

export default exportCollection;
