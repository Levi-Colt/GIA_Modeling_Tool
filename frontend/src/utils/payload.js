import { buildTiltModel } from './tiltModel.js'

// Builds the multipart fields for POST /api/process from form state. Lives in
// utils/ (not App.jsx) so it can be unit-tested without App.jsx's module
// graph (MapPanel -> georaster-layer-for-leaflet).
//
// Branches on mode. Basic reads only top-level fields, so anything stored in
// formState.advanced can never change a Basic run. Advanced currently sends the
// same fields plus `tilt_model` (a JSON string, as a multipart form field);
// later specs extend that object for vectors and shore points. Basic never
// sends it, so the server runs the plain linear tilt.
export function buildProcessPayload(formState) {
  const payload = buildSharedPayload(formState)
  if (formState.mode === 'advanced') {
    payload.tilt_model = JSON.stringify(buildTiltModel(formState.advanced))
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
