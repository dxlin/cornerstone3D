import * as cornerstoneStreamingImageVolumeLoader from '../src'
import * as cornerstone from '@precisionmetrics/cornerstone-render'

const {
  cache,
  metaData,
  Utilities,
  registerVolumeLoader,
  unregisterAllImageLoaders,
} = cornerstone

const { testUtils } = Utilities
// import { User } from ... doesn't work right now since we don't have named exports set up
const { StreamingImageVolume } = cornerstoneStreamingImageVolumeLoader

const imageIds = [
  'fakeSharedBufferImageLoader:imageId1',
  'fakeSharedBufferImageLoader:imageId2',
  'fakeSharedBufferImageLoader:imageId3',
  'fakeSharedBufferImageLoader:imageId4',
  'fakeSharedBufferImageLoader:imageId5',
]

const fakeSharedBufferImageLoader = (imageId, options) => {
  // imageId1 => all voxels = 1
  // imageId2 => all voxels = 2
  // etc.
  const imageIdNumber = imageId.split('imageId')[1]

  const pixelData = new Uint8Array(100 * 100)

  for (let i = 0; i < pixelData.length; i++) {
    pixelData[i] = Number(imageIdNumber)
  }

  // If we have a target buffer, write to that instead. This helps reduce memory duplication.
  const { arrayBuffer, offset, length } = options.targetBuffer

  const typedArray = new Uint8Array(arrayBuffer, offset, length)

  // TypedArray.Set is api level and ~50x faster than copying elements even for
  // Arrays of different types, which aren't simply memcpy ops.
  typedArray.set(pixelData, 0)

  return {
    promise: Promise.resolve(undefined),
  }
}

// regular imageLoader
const imageLoader = (imageId) => {
  // imageId1 => all voxels = 1
  // imageId2 => all voxels = 2
  // etc.
  const imageIdNumber = imageId.split('imageId')[1]

  const pixelData = new Uint8Array(100 * 100)

  for (let i = 0; i < pixelData.length; i++) {
    pixelData[i] = Number(imageIdNumber)
  }

  const image = {
    rows: 100,
    columns: 100,
    getPixelData: () => pixelData,
    sizeInBytes: 10000, // 100 * 100 * 1
  }

  return {
    promise: Promise.resolve(image),
  }
}

function setupLoaders() {
  cornerstone.registerImageLoader('fakeImageLoader', imageLoader)
  cornerstone.registerImageLoader(
    'fakeSharedBufferImageLoader',
    fakeSharedBufferImageLoader
  )

  const fakeVolumeLoader = (volumeId) => {
    const dimensions = [100, 100, 5]

    const volumeMetadata = {
      BitsAllocated: 8,
      PixelRepresentation: 0,
      PhotometricInterpretation: 'MONOCHROME1',
      ImageOrientationPatient: [0, 0, 1, 1, 0, 0, 0, 1, 0],
      PixelSpacing: [1, 1],
      Columns: dimensions[0],
      Rows: dimensions[1],
    }

    const scalarData = new Uint8Array(
      dimensions[0] * dimensions[1] * dimensions[2]
    )

    const streamingImageVolume = new StreamingImageVolume(
      // ImageVolume properties
      {
        uid: volumeId, // TODO: should we differentiate between volumeId and a volume's UID?
        metadata: volumeMetadata,
        dimensions: dimensions,
        spacing: [1, 1, 1],
        origin: [0, 0, 0],
        direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        scalarData,
        sizeInBytes: scalarData.byteLength,
      },
      // Streaming properties
      {
        imageIds,
        loadStatus: {
          loaded: false,
          loading: false,
          cachedFrames: [],
          callbacks: [],
        },
      }
    )

    return {
      promise: Promise.resolve(streamingImageVolume),
    }
  }

  cornerstone.registerVolumeLoader('fakeVolumeLoader', fakeVolumeLoader)

  return {
    imageIds,
    imageLoader,
  }
}

describe('renderingCore -- volume', () => {
  beforeAll(() => {
    // initialize the library
    cornerstone.init()
  })

  describe('StreamingImageVolume', function () {
    beforeAll(function () {
      const { imageIds, imageLoader } = setupLoaders()

      this.imageIds = imageIds
      this.imageLoader = imageLoader
    })

    it('load: correctly streams pixel data from Images into Volume via a SharedArrayBuffer', async function () {
      const volumeId = 'fakeVolumeLoader:VOLUME'

    // loading the volume
    const volume = cornerstone.getVolume(volumeId)
    const prefetch = false
    const callback = undefined
    // adding requests to the pool manager
    volume.load(callback, prefetch)

    // awaiting all promises for images after requested to be copied over
    for (let imageId of imageIds) {
      const cachedImage = cornerstone.cache.getImageLoadObject(imageId)
      const image = await cachedImage.promise
    }
    const pool = cornerstone.imageLoadPoolManager.getRequestPool()

    // expect no requests to be added to the request manager, since images
    // were already cached in the image cache
    let requests = Object.values(pool['prefetch']).flat()
    expect(requests.length).toBe(0)

    // Getting the volume to check for voxel intensities
    const volumeImage = volume.vtkImageData

    // first slice (z=0) voxels to be all 1
    let worldPos = volumeImage.indexToWorld([0, 0, 0])
    let intensity = volume.vtkImageData.getScalarValueFromWorld(worldPos)
    expect(intensity).toBe(1)

    // 5th slice (z=4) voxels to be all 5
    worldPos = volumeImage.indexToWorld([0, 0, 4])
    intensity = volume.vtkImageData.getScalarValueFromWorld(worldPos)

    expect(intensity).toBe(5)
  })

  it('load: leverages volume that are in the cache already for the image loading', async function () {
    const spyedImageLoader = jasmine.createSpy(this.imageLoader)

    const volumeId = 'fakeVolumeLoader:VOLUME'

    const imageIds = [
      'fakeImageLoader:imageId1',
      'fakeImageLoader:imageId2',
      'fakeImageLoader:imageId3',
      'fakeImageLoader:imageId4',
      'fakeImageLoader:imageId5',
    ]

    // caching volume
    await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
      imageIds: this.imageIds,
    })

    expect(cache.getCacheSize()).toBe(50000)

    // loading the volume
    const volume = cornerstone.getVolume(volumeId)
    const callback = undefined
    // adding requests to the pool manager
    volume.load(callback)

    expect(cache.getImageLoadObject(imageIds[0])).not.toBeDefined()

    // loading the images
    await cornerstone.loadAndCacheImages(imageIds)

    // imageLoader is not being called for any imageIds
    expect(spyedImageLoader).not.toHaveBeenCalled()

    // Images are copied over from the volume, check for the fourth image (imageId4)
    // which has pixel data of 4
    const imageLoadObject = cache.getImageLoadObject(imageIds[3])
    expect(cache.getCacheSize()).toBe(100000)
    expect(imageLoadObject).toBeDefined()

    imageLoadObject.promise.then((image) => {
      const pixelData = image.getPixelData()
      expect(pixelData[0]).toBe(4)
    })
  })

  // it('cancelLoading: ', async function () {
  //   await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
  //     imageIds: this.imageIds,
  //   })

  //   const volumeId = 'fakeVolumeLoader:VOLUME'
  //   const volume = cornerstone.getVolume(volumeId)

  //   const callback = undefined
  //   const prefetch = false
  //   volume.load(callback, prefetch)

  //   let pool = cornerstone.imageLoadPoolManager.getRequestPool()

  //   let numImagesInPool = Object.values(pool['prefetch']).flat().length
  //   expect(numImagesInPool).toEqual(5)
  //   expect(volume.loadStatus.loading).toEqual(true)

  //   volume.cancelLoading()

  //   pool = cornerstone.imageLoadPoolManager.getRequestPool()

  //   const requests = Object.values(pool['prefetch']).flat()

  //   numImagesInPool = requests.length
  //   expect(numImagesInPool).toEqual(0)

  //   expect(volume.loadStatus.loaded).toEqual(false)
  //   expect(volume.loadStatus.loading).toEqual(false)
  //   expect(volume.loadStatus.callbacks.length).toEqual(0)
  // })

  it('decache: properly decaches the Volume into a set of Images', async function () {
    await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
      imageIds: this.imageIds,
    })

    const volumeId = 'fakeVolumeLoader:VOLUME'
    const volume = cornerstone.getVolume(volumeId)
    const completelyRemove = false

    volume.load()

    const cacheSizeBeforeDecache = cache.getCacheSize()

    // turn volume into images
    volume.decache(completelyRemove)

    const cacheSizeAfterDecache = cache.getCacheSize()

    // Gets the volume
    const volAfterDecache = cornerstone.getVolume(volumeId)
    expect(volAfterDecache).not.toBeDefined()

    expect(cacheSizeBeforeDecache - cacheSizeAfterDecache).toBe(50000)

    for (let imageId of this.imageIds) {
      const cachedImage = cornerstone.cache.getImageLoadObject(imageId)

      expect(cachedImage).toBeDefined()

      const image = await cachedImage.promise
      expect(image.columns).toBe(100)
      expect(image.rows).toBe(100)
      expect(image.sizeInBytes).toBe(10000)
      expect(image.invert).toBe(true)
    }
  })

  it('decache: completely removes the Volume from the cache', async function () {
    await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
      imageIds: this.imageIds,
    })

    const volumeId = 'fakeVolumeLoader:VOLUME'
    const volume = cornerstone.getVolume(volumeId)

    const completelyRemove = true

    volume.load()

    const cacheSizeBeforePurge = cache.getCacheSize()
    expect(cacheSizeBeforePurge).toBe(50000)

    volume.decache(completelyRemove)

    // Gets the volume
    const volAfterDecache = cornerstone.getVolume(volumeId)
    expect(volAfterDecache).not.toBeDefined()

    const cacheSizeAfterPurge = cache.getCacheSize()
    expect(cacheSizeAfterPurge).toBe(0)

    const cachedImage0 = cache.getImageLoadObject(this.imageIds[0])

    expect(cachedImage0).not.toBeDefined()
  })

  afterEach(function () {
    cache.purgeCache()
  })
})

describe('CornerstoneVolumeStreaming Streaming --- ', function () {
  beforeEach(function () {
    cache.purgeCache()
    metaData.addProvider(testUtils.fakeMetaDataProvider, 10000)
    cornerstone.registerImageLoader(
      'fakeSharedBufferImageLoader',
      fakeSharedBufferImageLoader
    )
    registerVolumeLoader(
      'fakeSharedBufferImageLoader',
      testUtils.fakeImageLoader
    )
  })

  afterEach(function () {
    cache.purgeCache()
    metaData.removeProvider(testUtils.fakeMetaDataProvider)
    unregisterAllImageLoaders()
  })

  it('should successfully use metadata for streaming image volume', async function () {
    const imageIds = [
      'fakeSharedBufferImageLoader:myImag1_256_256_0_20_1_1_0',
      'fakeSharedBufferImageLoader:myImage2_256_256_0_20_1_1_0',
      'fakeSharedBufferImageLoader:myImage3_256_256_0_20_1_1_0',
      'fakeSharedBufferImageLoader:myImage4_256_256_0_20_1_1_0',
      'fakeSharedBufferImageLoader:myImage5_256_256_0_20_1_1_0',
    ]

    // fake volume generator follows the pattern of
    // volumeScheme:volumeURI_xSize_ySize_zSize_barStart_barWidth_xSpacing_ySpacing_zSpacing_rgbFlag
    const volumeId = 'cornerstoneStreamingImageVolume:volume'

    try {
      await cornerstone.createAndCacheVolume(volumeId, {
        imageIds: this.imageIds,
      })
      const volume = cornerstone.getVolume(volumeId)

      let framesLoaded = 0
      const callback = (evt) => {
        framesLoaded++

        if (framesLoaded === this.imageIds.length) {
          // Getting the volume to check for voxel intensities
          const volumeLoadObject = cache.getVolumeLoadObject(volumeId)
          volumeLoadObject.promise.then((volume) => {
            const volumeImage = volume.imageData
            // first slice (z=0) voxels to be all 1
            let worldPos = volumeImage.indexToWorld([0, 0, 0])
            let intensity = volume.imageData.getScalarValueFromWorld(worldPos)
            expect(intensity).toBe(1)
            // 4th slice (z=3) voxels to be all 4
            worldPos = volumeImage.indexToWorld([0, 0, 3])
            intensity = volume.imageData.getScalarValueFromWorld(worldPos)
            expect(intensity).toBe(4)
          })
        }
      }

      volume.load(callback)
    })

    it('load: leverages images already in the cache for loading a volume', async function () {
      const volumeId = 'fakeVolumeLoader:VOLUME'

      const imageIds = [
        'fakeImageLoader:imageId1',
        'fakeImageLoader:imageId2',
        'fakeImageLoader:imageId3',
        'fakeImageLoader:imageId4',
        'fakeImageLoader:imageId5',
      ]

      // loading the images first
      await cornerstone.loadAndCacheImages(imageIds)

      // only cached images so far
      expect(cache.getCacheSize()).toBe(50000)
      expect(cache.getImageLoadObject(imageIds[0])).toBeDefined()

      // caching volume
      await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
        imageIds: this.imageIds,
      })

      expect(cache.getCacheSize()).toBe(100000)

      // loading the volume
      const volume = cornerstone.getVolume(volumeId)
      const prefetch = false
      const callback = undefined
      // adding requests to the pool manager
      volume.load(callback, prefetch)

      // awaiting all promises for images after requested to be copied over
      for (let imageId of imageIds) {
        const cachedImage = cornerstone.cache.getImageLoadObject(imageId)
        const image = await cachedImage.promise
      }
      const pool = cornerstone.requestPoolManager.getRequestPool()

      // expect no requests to be added to the request manager, since images
      // were already cached in the image cache
      let requests = Object.values(pool['prefetch']).flat()
      expect(requests.length).toBe(0)

      // Getting the volume to check for voxel intensities
      const volumeImage = volume.imageData

      // first slice (z=0) voxels to be all 1
      let worldPos = volumeImage.indexToWorld([0, 0, 0])
      let intensity = volume.imageData.getScalarValueFromWorld(worldPos)
      expect(intensity).toBe(1)

      // 5th slice (z=4) voxels to be all 5
      worldPos = volumeImage.indexToWorld([0, 0, 4])
      intensity = volume.imageData.getScalarValueFromWorld(worldPos)

      expect(intensity).toBe(5)
    })

    it('load: leverages volume that are in the cache already for the image loading', async function () {
      const spyedImageLoader = jasmine.createSpy(this.imageLoader)

      const volumeId = 'fakeVolumeLoader:VOLUME'

      const imageIds = [
        'fakeImageLoader:imageId1',
        'fakeImageLoader:imageId2',
        'fakeImageLoader:imageId3',
        'fakeImageLoader:imageId4',
        'fakeImageLoader:imageId5',
      ]

      // caching volume
      await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
        imageIds: this.imageIds,
      })

      expect(cache.getCacheSize()).toBe(50000)

      // loading the volume
      const volume = cornerstone.getVolume(volumeId)
      const callback = undefined
      // adding requests to the pool manager
      volume.load(callback)

      expect(cache.getImageLoadObject(imageIds[0])).not.toBeDefined()

      // loading the images
      await cornerstone.loadAndCacheImages(imageIds)

      // imageLoader is not being called for any imageIds
      expect(spyedImageLoader).not.toHaveBeenCalled()

      // Images are copied over from the volume, check for the fourth image (imageId4)
      // which has pixel data of 4
      const imageLoadObject = cache.getImageLoadObject(imageIds[3])
      expect(cache.getCacheSize()).toBe(100000)
      expect(imageLoadObject).toBeDefined()

      imageLoadObject.promise.then((image) => {
        const pixelData = image.getPixelData()
        expect(pixelData[0]).toBe(4)
      })
    })

    // it('cancelLoading: ', async function () {
    //   await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
    //     imageIds: this.imageIds,
    //   })

    //   const volumeId = 'fakeVolumeLoader:VOLUME'
    //   const volume = cornerstone.getVolume(volumeId)

    //   const callback = undefined
    //   const prefetch = false
    //   volume.load(callback, prefetch)

    //   let pool = cornerstone.requestPoolManager.getRequestPool()

    //   let numImagesInPool = Object.values(pool['prefetch']).flat().length
    //   expect(numImagesInPool).toEqual(5)
    //   expect(volume.loadStatus.loading).toEqual(true)

    //   volume.cancelLoading()

    //   pool = cornerstone.requestPoolManager.getRequestPool()

    //   const requests = Object.values(pool['prefetch']).flat()

    //   numImagesInPool = requests.length
    //   expect(numImagesInPool).toEqual(0)

    //   expect(volume.loadStatus.loaded).toEqual(false)
    //   expect(volume.loadStatus.loading).toEqual(false)
    //   expect(volume.loadStatus.callbacks.length).toEqual(0)
    // })

    it('decache: properly decaches the Volume into a set of Images', async function () {
      await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
        imageIds: this.imageIds,
      })

      const volumeId = 'fakeVolumeLoader:VOLUME'
      const volume = cornerstone.getVolume(volumeId)
      const completelyRemove = false

      volume.load()

      const cacheSizeBeforeDecache = cache.getCacheSize()

      // turn volume into images
      volume.decache(completelyRemove)

      const cacheSizeAfterDecache = cache.getCacheSize()

      // Gets the volume
      const volAfterDecache = cornerstone.getVolume(volumeId)
      expect(volAfterDecache).not.toBeDefined()

      expect(cacheSizeBeforeDecache - cacheSizeAfterDecache).toBe(50000)

      for (let imageId of this.imageIds) {
        const cachedImage = cornerstone.cache.getImageLoadObject(imageId)

        expect(cachedImage).toBeDefined()

        const image = await cachedImage.promise
        expect(image.columns).toBe(100)
        expect(image.rows).toBe(100)
        expect(image.sizeInBytes).toBe(10000)
        expect(image.invert).toBe(true)
      }
    })

    it('decache: completely removes the Volume from the cache', async function () {
      await cornerstone.createAndCacheVolume('fakeVolumeLoader:VOLUME', {
        imageIds: this.imageIds,
      })

      const volumeId = 'fakeVolumeLoader:VOLUME'
      const volume = cornerstone.getVolume(volumeId)

      const completelyRemove = true

      volume.load()

      const cacheSizeBeforePurge = cache.getCacheSize()
      expect(cacheSizeBeforePurge).toBe(50000)

      volume.decache(completelyRemove)

      // Gets the volume
      const volAfterDecache = cornerstone.getVolume(volumeId)
      expect(volAfterDecache).not.toBeDefined()

      const cacheSizeAfterPurge = cache.getCacheSize()
      expect(cacheSizeAfterPurge).toBe(0)

      const cachedImage0 = cache.getImageLoadObject(this.imageIds[0])

      expect(cachedImage0).not.toBeDefined()
    })

    afterEach(function () {
      cache.purgeCache()
    })
  })

  describe('CornerstoneVolumeStreaming Streaming --- ', function () {
    beforeEach(function () {
      cache.purgeCache()
      metaData.addProvider(testUtils.fakeMetaDataProvider, 10000)
      cornerstone.registerImageLoader(
        'fakeSharedBufferImageLoader',
        fakeSharedBufferImageLoader
      )
      registerVolumeLoader(
        'fakeSharedBufferImageLoader',
        testUtils.fakeImageLoader
      )
    })

    afterEach(function () {
      cache.purgeCache()
      metaData.removeProvider(testUtils.fakeMetaDataProvider)
      unregisterAllImageLoaders()
    })

    it('should successfully use metadata for streaming image volume', async function (done) {
      const imageIds = [
        'fakeSharedBufferImageLoader:myImag1_256_256_0_20_1_1_0',
        'fakeSharedBufferImageLoader:myImage2_256_256_0_20_1_1_0',
        'fakeSharedBufferImageLoader:myImage3_256_256_0_20_1_1_0',
        'fakeSharedBufferImageLoader:myImage4_256_256_0_20_1_1_0',
        'fakeSharedBufferImageLoader:myImage5_256_256_0_20_1_1_0',
      ]

      // fake volume generator follows the pattern of
      // volumeScheme:volumeURI_xSize_ySize_zSize_barStart_barWidth_xSpacing_ySpacing_zSpacing_rgbFlag
      const volumeId = 'cornerstoneStreamingImageVolume:volume'

      try {
        await cornerstone.createAndCacheVolume(volumeId, {
          imageIds: imageIds,
        })
        const volume = cornerstone.getVolume(volumeId)

        let framesLoaded = 0
        const callback = (evt) => {
          framesLoaded++
          if (framesLoaded === imageIds.length) {
            // Getting the volume to check for voxel intensities
            done()
          }
        }
        volume.load(callback)
      } catch (e) {
        done.fail(e)
      }
    })
  })
})
