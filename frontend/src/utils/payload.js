import { buildTiltModel, usingPoints, usingVectors } from './tiltModel.js'
import { allCustom, normalizeVectors } from './vectors.js'

// Builds the multipart fields for POST /api/process from form state. Lives in
// utils/ (not App.jsx) so it can be unit-tested without App.jsx's module
// graph (MapPanel -> georaster-layer-for-leaflet).
//
// Branches on mode. Basic reads only top-level fields, so anything stored in
// formState.advanced can never change a Basic run. Advanced sends the same
// fields plus `tilt_model` (a JSON string, as a multipart form field); Basic
// never sends it, so the server runs the plain linear tilt. Vectors mode
// (Advanced, direction source 'vectors') sends no `tilt_azimuth` (there is no
// single azimuth) and omits `tilt_factor` only when every vector has a custom
// tilt (no vector then uses the global profile). Shore-points mode sends neither,
// and its `tilt_model` has no top-level profile or hinge.
export function buildProcessPayload(formState) {
  const payload = buildSharedPayload(formState)
  if (formState.mode === 'advanced') {
    payload.tilt_model = JSON.stringify(buildTiltModel(formState.advanced))
    if (usingVectors(formState)) {
      delete payload.tilt_azimuth
      if (allCustom(normalizeVectors(formState.advanced.vectors))) delete payload.tilt_factor
    }
    if (usingPoints(formState)) {
      // Neither applies to a fitted surface: the data give direction and magnitude.
      delete payload.tilt_azimuth
      delete payload.tilt_factor
    }
  }
  return payload
}

function buildSharedPayload(formState) {
  return {
    ...(formState.demFile ? { dem_file: formState.demFile } : { file_path: formState.demPath }),
    origin_mode: formState.originMode,
    origin_value: formState.originValue,
    ...(formState.originMode === 'epsg' ? { origin_epsg: formState.originEpsg } : {}),
    tilt_azimuth: formState.tiltAzimuth,
    tilt_factor: formState.tiltFactor,
    target_elevation: formState.targetElevation,
    include_dem: formState.includeDem,
    ...(formState.selectionRadiusKm !== '' && formState.selectionRadiusKm != null
      ? { selection_radius_km: formState.selectionRadiusKm }
      : {})
  }
}
