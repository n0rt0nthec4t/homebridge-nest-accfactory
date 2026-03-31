// Translation Engine - Nest / Google data normalisation
// Part of homebridge-nest-accfactory
//
// Provides a lightweight translation layer for converting raw Nest and Google API data
// into a unified internal device model.
//
// Responsibilities:
// - Map source-specific data (Nest / Google) to canonical device fields
// - Resolve values using configurable field maps (string paths or functions)
// - Support source preference and fallback handling
// - Allow custom merge logic for complex field resolution
// - Provide reusable helpers for mapping, merging, and context construction
//
// Features:
// - Field map definitions supporting:
//   - String-based path extraction
//   - Function-based value resolution
// - Source preference handling (Nest vs Google)
// - Automatic fallback and default value support
// - Custom merge functions per field
// - Safe value resolution with error handling
//
// Notes:
// - Designed to isolate API differences from device implementations
// - Each device module defines its own FIELD_MAP using this engine
// - Google API data is typically preferred when available
// - Missing or invalid values resolve to undefined (not placeholder defaults)
//
// Data Flow:
// - createMappingContext() builds a source-aware context object
// - buildMappedObject() resolves all fields using the field map
// - resolveMappedField() applies preference, merge logic, and fallbacks
// - mergeMappedObjects() combines mapped results when required
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
