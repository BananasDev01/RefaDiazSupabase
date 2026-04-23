export interface ProductCatalogParams {
  name?: string;
  productTypeId?: string;
  brandId?: string;
  modelId?: string;
  modelYear?: string;
  productCategoryId?: string;
  pagination?: ProductPaginationParams;
}

export interface ProductPaginationParams {
  limit: number;
  offset: number;
}
