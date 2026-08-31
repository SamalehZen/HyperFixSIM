export interface CustomBoundarySet {
  key: string
  label: string
  url: string
  joinProperty: string
  regionKeyHint: string
  featureCount?: number
}

export interface MapSettings {
  customBoundaries?: CustomBoundarySet[]
}
