// Helper functions for translating raw Nest and Google API data into a common internal format.
//
// This module provides a small translation engine that allows each device module
// to define a field map for canonical/internal device properties, while keeping
// source-specific extraction logic local to the device module.
//
// Supported field map entry formats:
// {
//   fieldName: {
//     nest: 'value.some.path',
//     google: 'value.some.other.path',
//     prefer: DATA_SOURCE.GOOGLE,
//     defaultValue: '',
//     merge: ({ nestValue, googleValue, context, fieldMap, fieldName }) => ...
//   }
// }
//
// or
//
// {
//   fieldName: {
//     nest: ({ rawData, objectKey, sourceValue, source, nestValue, googleValue }) => ...,
//     google: ({ rawData, objectKey, sourceValue, source, nestValue, googleValue }) => ...,
//   }
// }
//
// Notes:
// - String mappings are resolved as dot-separated paths against the supplied source object.
// - Function mappings receive a context object for maximum flexibility.
// - If no custom merge function is supplied, the preferred source is used first,
//   then the other source, then the optional defaultValue.
//
//
// Part of homebridge-nest-accfactory
//
// Code version 2026.03.12
// Mark Hulskamp

import { DATA_SOURCE } from './consts.js';

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

// Resolve one mapping entry (string path or function) for a single source
function getMappedValue(mapping, context) {
  if (context?.sourceValue === undefined) {
    return undefined;
  }

  if (typeof mapping === 'function') {
    try {
      return mapping(context);
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      return undefined;
    }
  }

  if (typeof mapping === 'string' && mapping.trim() !== '') {
    return getPath(context.sourceValue, mapping);
  }

  return undefined;
}

// Helper to normalise a source object for translation
function normaliseSourceContext(source, objectKey, sourceValue, extraContext = undefined) {
  let context = {
    source: source,
    objectKey: objectKey,
    sourceValue: sourceValue,
  };

  if (extraContext !== null && typeof extraContext === 'object' && extraContext?.constructor === Object) {
    Object.entries(extraContext).forEach(([key, value]) => {
      context[key] = value;
    });
  }

  return context;
}

// Resolve a single canonical field from a field map entry
function resolveMappedField(fieldName, fieldMap, context) {
  let nestContext = {
    ...context,
    ...context.nestValue,
  };
  let googleContext = {
    ...context,
    ...context.googleValue,
  };
  let nestValue = getMappedValue(fieldMap?.nest, nestContext);
  let googleValue = getMappedValue(fieldMap?.google, googleContext);

  if (typeof fieldMap?.merge === 'function') {
    try {
      return fieldMap.merge({
        fieldName: fieldName,
        fieldMap: fieldMap,
        context: context,
        nestValue: nestValue,
        googleValue: googleValue,
      });
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      return hasMappedValue(fieldMap?.defaultValue) === true ? fieldMap.defaultValue : undefined;
    }
  }

  if (fieldMap?.prefer === DATA_SOURCE.NEST) {
    if (hasMappedValue(nestValue) === true) {
      return nestValue;
    }

    if (hasMappedValue(googleValue) === true) {
      return googleValue;
    }
  }

  if (hasMappedValue(googleValue) === true) {
    return googleValue;
  }

  if (hasMappedValue(nestValue) === true) {
    return nestValue;
  }

  return hasMappedValue(fieldMap?.defaultValue) === true ? fieldMap.defaultValue : undefined;
}

// Build a mapped object from a field map definition
function buildMappedObject(fieldMap, context) {
  let mappedObject = {};

  if (fieldMap === null || typeof fieldMap !== 'object' || fieldMap?.constructor !== Object) {
    return mappedObject;
  }

  Object.entries(fieldMap).forEach(([fieldName, mapEntry]) => {
    mappedObject[fieldName] = resolveMappedField(fieldName, mapEntry, context);
  });

  return mappedObject;
}

// Merge two already-mapped objects together using a preferred source ordering
function mergeMappedObjects(primaryObject, secondaryObject) {
  let mergedObject = {};

  if (secondaryObject !== null && typeof secondaryObject === 'object' && secondaryObject?.constructor === Object) {
    Object.entries(secondaryObject).forEach(([key, value]) => {
      mergedObject[key] = value;
    });
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
function createMappingContext(rawData, objectKey, nestValue = undefined, googleValue = undefined, extraContext = undefined) {
  let context = {
    rawData: rawData,
    objectKey: objectKey,
    nestValue: normaliseSourceContext(DATA_SOURCE.NEST, objectKey, nestValue),
    googleValue: normaliseSourceContext(DATA_SOURCE.GOOGLE, objectKey, googleValue),
  };

  if (extraContext !== null && typeof extraContext === 'object' && extraContext?.constructor === Object) {
    Object.entries(extraContext).forEach(([key, value]) => {
      context[key] = value;
    });
  }

  return context;
}

export {
  buildMappedObject,
  createMappingContext,
  getMappedValue,
  getPath,
  hasMappedValue,
  mergeMappedObjects,
  normaliseSourceContext,
  resolveMappedField,
};
