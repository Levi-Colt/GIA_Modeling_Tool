# GIA_Modeling_Tool
This tool uses modern DEM data to simulate glacial isostatic adjustment (GIA) for the purpose of identifying potential paleo strandlines.

## Documentation
This application utilizes the following core libraries for spatial data processing:
* [skimage contouring](https://scikit-image.org/docs/stable/auto_examples/edges/plot_contours.html) - Used to find constant value contours in an image.
* [rasterio](https://rasterio.readthedocs.io/en/stable/) - Used for reading/writing GeoTIFF file.
* [geopandas](https://geopandas.org/en/stable/docs.html) - Used for configuring and exporting GeoPackage product.
* [NumPy ](https://numpy.org/doc/stable/) - Used to manipulate DEM as a 2-D array.
* [Shapely ](https://shapely.readthedocs.io/) - Used for the creation, manipulation, and analytical tracking of the resulting vector geometries before they are serialized into a GeoPackage.