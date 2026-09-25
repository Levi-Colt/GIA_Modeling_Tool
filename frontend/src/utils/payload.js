// Builds the multipart fields for POST /api/process from form state. Lives in
// utils/ (not App.jsx) so it can be unit-tested without App.jsx's module
// graph (MapPanel -> georaster-layer-for-leaflet).
export function buildProcessPayload(formState) {
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
