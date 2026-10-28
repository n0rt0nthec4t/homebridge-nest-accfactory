// Translation Engine - generic field-map data normalisation
// Part of homebridge-nest-accfactory
//
// Provides a lightweight translation layer for converting raw source data
// into a unified internal device model.
//
// Responsibilities:
// - Map source-specific data to canonical device fields
// - Resolve values using configurable field maps (string paths or functions)
// - Support source preference and fallback handling
// - Allow custom merge logic for complex field resolution
// - Support partial (delta) updates and full object construction
// - Provide reusable helpers for mapping, merging, and context construction
//
// Features:
// - Field map definitions supporting:
//   - String-based path extraction
//   - Function-based value resolution
//   - Object-based source config with:
//       - translate: value resolver
//       - fields: raw fields on the current object this mapping depends on
//       - related: raw fields on related objects (via rawData) this mapping depends on
//   - required: marks fields needed for a minimum viable (full) object
// - Generic source handling (not tied to Nest / Google)
// - Automatic fallback and default value support
// - Custom merge functions per field
// - Safe value resolution with error handling
//
// Delta / inclusion behaviour:
// - buildMappedObject() requires a Set of raw field names to include
// - A mapped field is included if any of its declared dependencies match:
//     fields ∪ related
// - fields and related are treated equally for inclusion decisions
// - If no dependencies are declared, the field is always included
//
// Output model:
// - buildMappedObject() returns:
//     {
//       data: <mapped fields>,
//       hasRequired: <true if all required fields are present>
//     }
// - hasRequired indicates whether the result is a complete "minimum viable"
//   object (e.g. safe to construct a device) or a partial update
//
// Notes:
// - Designed to isolate raw source differences from device implementations
// - Each device module defines its own FIELD_MAP using this engine
// - Missing or invalid values resolve to undefined (not placeholder defaults)
// - Related data is resolved via rawData during translation; callers are
//   responsible for including relevant changed field names in delta updates
//
// Data flow:
// - createMappingContext() builds a source-aware context object
// - buildMappedObject() resolves all fields using the field map
// - resolveMappedField() applies preference, merge logic, and fallbacks
// - mergeMappedObjects() combines mapped results when required
//
// Basic usage:
// - Define a FIELD_MAP in a device module:
//     const FIELD_MAP = {
//       online: {
//         required: true,
//         google: {
//           fields: ['liveness'],
//           translate: ({ raw }) => raw?.value === 'LIVENESS_DEVICE_STATUS_ONLINE',
//         },
//         nest: 'online',
//         prefer: 'google',
//         defaultValue: false,
//       },
//     };
//
// - Build a source-aware context:
//     let context = createMappingContext(rawData, objectKey, {
//       google: googleRawObject,
//       nest: nestRawObject,
//     });
//
// - Build a mapped object:
//     let result = buildMappedObject(FIELD_MAP, context, new Set(['liveness']));
//
// - Use result.data for device updates and result.hasRequired to determine
//   whether the mapped result is complete enough to create a new device.
//
// Code version 2026.10.26
// Mark Hulskamp

// Safely read a dot-separated path from an object
function getPath(object, path) {
  if (object === null || typeof object !== 'object' || typeof path !== 'string' || path.trim() === '') {
    return undefined;
  }

  return path.split('.').reduce((value, key) => value?.[key], object);
}

// Determine if a mapped value should be considered usable
function hasMappedValue(value) {
  return value !== undefined && value !== null && value !== '';
}

// Determine if all required fields defined in the field map
// are present in the mapped data object.
//
// A field is considered required if `required: true` is set
// in the field map definition.
//
// This is used to determine whether the mapped result represents
// a complete "minimum viable" object (e.g. safe to create a device),
// versus a partial update (delta) where only some fields are present.
function hasRequiredFields(mappedData, fieldMap) {
  if (
    mappedData === null ||
    typeof mappedData !== 'object' ||
    mappedData?.constructor !== Object ||
    fieldMap === null ||
    typeof fieldMap !== 'object' ||
    fieldMap?.constructor !== Object
  ) {
    return false;
  }

  // Check that every required field exists in the mapped data
  return Object.entries(fieldMap).every(([fieldName, mapEntry]) => mapEntry?.required !== true || mappedData[fieldName] !== undefined);
}

// Resolve one mapping entry for a single source
// Supported mapping types:
// - function
// - string path
// - object containing translate function or translate string path
function getMappedValue(mapping, context) {
  if (context?.raw === undefined) {
    return undefined;
  }

  // Unwrap source metadata once, retaining the receiver for translate methods.
  let owner = mapping !== null && typeof mapping === 'object' && mapping?.constructor === Object ? mapping : undefined;
  let resolver = owner === undefined ? mapping : mapping.translate;

  if (typeof resolver === 'function') {
    try {
      return resolver.call(owner, context);
    } catch {
      // An unusable source must still allow another source or declared default.
      return undefined;
    }
  }

  return typeof resolver === 'string' ? getPath(context.raw, resolver) : undefined;
}

// Helper to normalise a source object for translation
function normaliseSourceContext(source, objectKey, raw, extraContext = undefined) {
  let context = {
    source: source,
    objectKey: objectKey,
    raw: raw,
  };

  if (extraContext !== null && typeof extraContext === 'object' && extraContext?.constructor === Object) {
    Object.assign(context, extraContext);
  }

  return context;
}

// Resolve a single canonical field from a field map entry
function resolveMappedField(fieldName, fieldMap, context) {
  let values = {};
  let preferredValue = undefined;
  let resolvedValue = undefined;
  let sourceKeys = [];

  if (fieldMap === null || typeof fieldMap !== 'object' || fieldMap?.constructor !== Object) {
    return undefined;
  }

  sourceKeys = Object.keys(context?.sources ?? {}).filter(
    (sourceKey) => Object.hasOwn(fieldMap, sourceKey) === true && ['merge', 'prefer', 'defaultValue'].includes(sourceKey) === false,
  );

  sourceKeys.forEach((sourceKey) => {
    let sourceContext = {
      ...context,
      ...(context?.sources?.[sourceKey] ?? {}),
    };

    values[sourceKey] = getMappedValue(fieldMap[sourceKey], sourceContext);
  });

  if (typeof fieldMap?.merge === 'function') {
    try {
      return fieldMap.merge({
        fieldName: fieldName,
        fieldMap: fieldMap,
        context: context,
        values: values,
        defaultValue: fieldMap?.defaultValue,
      });
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      return hasMappedValue(fieldMap?.defaultValue) === true ? fieldMap.defaultValue : undefined;
    }
  }

  if (typeof fieldMap?.prefer === 'string' && hasMappedValue(values?.[fieldMap.prefer]) === true) {
    preferredValue = values[fieldMap.prefer];
  }

  if (hasMappedValue(preferredValue) === true) {
    return preferredValue;
  }

  resolvedValue = Object.values(values).find((value) => hasMappedValue(value) === true);
  if (hasMappedValue(resolvedValue) === true) {
    return resolvedValue;
  }

  return hasMappedValue(fieldMap?.defaultValue) === true ? fieldMap.defaultValue : undefined;
}

// Build a mapped object from a field map definition.
// Only mapped fields whose declared dependencies match `includeFields`
// will be resolved from the raw source data.
//
// `includeFields` must be a Set of changed raw field names for the current object.
// If `includeFields` is not a Set, no fields will be mapped and an empty result
// will be returned.
//
// For inclusion checks, `fields` and `related` are treated the same way here.
// The distinction is still useful in the field map for readability:
// - fields  -> depends on the current raw object
// - related -> depends on another raw object looked up via rawData
//
// Returns:
// - data: mapped fields that were included and resolved
// - hasRequired: true if all required fields are present in the mapped result
function buildMappedObject(fieldMap, context, includeFields = undefined) {
  let mappedObject = {};

  if (fieldMap === null || typeof fieldMap !== 'object' || fieldMap?.constructor !== Object) {
    return { data: mappedObject, hasRequired: false };
  }

  // No includeFields means no work to do for this object
  if (includeFields instanceof Set !== true) {
    return { data: mappedObject, hasRequired: false };
  }

  // Source membership is stable for this build, including entries with no raw value.
  let sourceKeys = Object.keys(context?.sources ?? {});
  let hasRequired = true;

  for (let [fieldName, mapEntry] of Object.entries(fieldMap)) {
    let shouldInclude = sourceKeys.some((sourceKey) => {
      if (Object.hasOwn(mapEntry, sourceKey) !== true) {
        return false;
      }

      let sourceMap = mapEntry[sourceKey];
      let fields = Array.isArray(sourceMap?.fields) === true ? sourceMap.fields : [];
      let related = Array.isArray(sourceMap?.related) === true ? sourceMap.related : [];

      // Empty dependency lists include identity and other unconditional fields.
      return (
        (fields.length === 0 && related.length === 0) ||
        fields.some((field) => includeFields.has(field) === true) ||
        related.some((field) => includeFields.has(field) === true)
      );
    });

    if (shouldInclude === true) {
      mappedObject[fieldName] = resolveMappedField(fieldName, mapEntry, context);
    }

    // Completeness concerns this result, including required fields excluded above.
    // Keep mapping later fields even when this result can only be a partial update.
    if (mapEntry?.required === true && mappedObject[fieldName] === undefined) {
      hasRequired = false;
    }
  }

  return { data: mappedObject, hasRequired };
}

// Merge two already-mapped objects together using a preferred source ordering
function mergeMappedObjects(primaryObject, secondaryObject) {
  let mergedObject = {};

  if (secondaryObject !== null && typeof secondaryObject === 'object' && secondaryObject?.constructor === Object) {
    Object.assign(mergedObject, secondaryObject);
  }

  if (primaryObject !== null && typeof primaryObject === 'object' && primaryObject?.constructor === Object) {
    Object.entries(primaryObject).forEach(([key, value]) => {
      if (hasMappedValue(value) === true) {
        mergedObject[key] = value;
      }
    });
  }

  return mergedObject;
}

// Helper to build a mapping context object
function createMappingContext(rawData, objectKey, sources = {}, extraContext = undefined) {
  let context = {
    rawData: rawData,
    objectKey: objectKey,
    sources: {},
  };

  if (sources !== null && typeof sources === 'object' && sources?.constructor === Object) {
    Object.entries(sources).forEach(([sourceKey, raw]) => {
      context.sources[sourceKey] = normaliseSourceContext(sourceKey, objectKey, raw);
    });
  }

  if (extraContext !== null && typeof extraContext === 'object' && extraContext?.constructor === Object) {
    Object.assign(context, extraContext);
  }

  return context;
}

export {
  buildMappedObject,
  createMappingContext,
  getMappedValue,
  getPath,
  hasMappedValue,
  hasRequiredFields,
  mergeMappedObjects,
  normaliseSourceContext,
  resolveMappedField,
};
