// Builds the multipart fields for POST /api/process from form state. Lives in
// utils/ (not App.jsx) so it can be unit-tested without App.jsx's module
// graph (MapPanel -> georaster-layer-for-leaflet).
//
// Branches on mode. Basic reads only top-level fields, so anything stored in
// formState.advanced can never change a Basic run. Advanced currently sends the
// same payload; later specs add `tilt_model` in its branch.
export function buildProcessPayload(formState) {
  const payload = buildSharedPayload(formState)
  if (formState.mode === 'advanced') {
    // Later specs add the `tilt_model` field here.
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
