// Code and structure based on OHIF Viewer:
// extensions\tmtv\src\utils\dicomRTAnnotationExport\RTStructureSet\RTSSReport.js

import { generateContourSetFromSegmentation } from "./generateContourSetFromSegmentation";
import dcmjs from "dcmjs";
import {
    getPatientModule,
    getReferencedFrameOfReferenceSequence,
    getReferencedSeriesSequence,
    getRTSeriesModule,
    getStructureSetModule
} from "./utilities";

const { DicomMetaDictionary } = dcmjs.data;

export default class RTSS {
    /**
     * Convert handles to RTSS report containing the dcmjs dicom dataset.
     *
     * Note: current WIP and using segmentations to contour conversion,
     * routine that is not fully tested
     *
     * @param segmentations - Array of Cornerstone tool segmentation data
     * @param metadataProvider - Metadata provider
     * @param DicomMetadataStore - metadata store instance
     * @param cs - cornerstone instance
     * @param csTools - cornerstone tool instance
     * @returns Report object containing the dataset
     */
    static async generateRTSS(
        segmentations,
        metadataProvider,
        DicomMetadataStore,
        cs,
        csTools
    ) {
        // Convert segmentations to ROIContours
        const roiContours = [];
        await segmentations.forEach(async (segmentation, segIndex) => {
            const contourSet = await generateContourSetFromSegmentation(
                segmentation,
                cs,
                csTools
            );

            // Check contour set isn't undefined
            if (contourSet) {
                const contourSequence = [];
                contourSet.sliceContours.forEach(sliceContour => {
                    /**
                     * addContour - Adds a new ROI with related contours to ROIContourSequence
                     *
                     * @param newContour - cornerstoneTools `ROIContour` object
                     *
                     * newContour = {
                     *   name: string,
                     *   description: string,
                     *   contourSequence: array[contour]
                     *   color: array[number],
                     *   metadata: {
                     *       referencedImageId: string,
                     *       FrameOfReferenceUID: string
                     *     }
                     * }
                     *
                     * contour = {
                     *   ContourImageSequence: array[
                     *       { ReferencedSOPClassUID: string, ReferencedSOPInstanceUID: string}
                     *     ]
                     *   ContourGeometricType: string,
                     *   NumberOfContourPoints: number,
                     *   ContourData: array[number]
                     * }
                     */
                    // Note: change needed if support non-planar contour representation is needed
                    const sopCommon = metadataProvider.get(
                        "sopCommonModule",
                        sliceContour.referencedImageId
                    );
                    const ReferencedSOPClassUID = sopCommon.sopClassUID;
                    const ReferencedSOPInstanceUID = sopCommon.sopInstanceUID;
                    const ContourImageSequence = [
                        { ReferencedSOPClassUID, ReferencedSOPInstanceUID } // NOTE: replace in dcmjs?
                    ];

                    const sliceContourPolyData = sliceContour.polyData;

                    sliceContour.contours.forEach((contour, index) => {
                        const ContourGeometricType = contour.type;
                        const NumberOfContourPoints =
                            contour.contourPoints.length;
                        const ContourData = [];

                        contour.contourPoints.forEach(point => {
                            const pointData =
                                sliceContourPolyData.points[point];
                            pointData[0] = +pointData[0].toFixed(2);
                            pointData[1] = +pointData[1].toFixed(2);
                            pointData[2] = +pointData[2].toFixed(2);
                            ContourData.push(pointData[0]);
                            ContourData.push(pointData[1]);
                            ContourData.push(pointData[2]);
                        });

                        contourSequence.push({
                            ContourImageSequence,
                            ContourGeometricType,
                            NumberOfContourPoints,
                            ContourNumber: index + 1,
                            ContourData
                        });
                    });
                });

                const segLabel =
                    contourSet.label || `Segmentation ${segIndex + 1}`;

                const ROIContour = {
                    name: segLabel,
                    description: segLabel,
                    contourSequence,
                    color: contourSet.color,
                    metadata: contourSet.metadata
                };

                roiContours.push(ROIContour);
            }
        });

        let dataset = initializeDataset(
            roiContours[0].metadata,
            metadataProvider
        );

        roiContours.forEach((contour, index) => {
            const roiContour = {
                ROIDisplayColor: contour.color || [255, 0, 0],
                ContourSequence: contour.contourSequence,
                ReferencedROINumber: index + 1
            };

            dataset.StructureSetROISequence.push(
                getStructureSetModule(contour, index, metadataProvider)
            );

            dataset.ROIContourSequence.push(roiContour);

            // ReferencedSeriesSequence
            dataset.ReferencedSeriesSequence = getReferencedSeriesSequence(
                contour,
                index,
                metadataProvider,
                DicomMetadataStore
            );

            // ReferencedFrameOfReferenceSequence
            dataset.ReferencedFrameOfReferenceSequence =
                getReferencedFrameOfReferenceSequence(
                    contour,
                    metadataProvider,
                    dataset
                );
        });

        const fileMetaInformationVersionArray = new Uint8Array(2);
        fileMetaInformationVersionArray[1] = 1;

        const _meta = {
            FileMetaInformationVersion: {
                Value: [fileMetaInformationVersionArray.buffer],
                vr: "OB"
            },
            TransferSyntaxUID: {
                Value: ["1.2.840.10008.1.2.1"],
                vr: "UI"
            },
            ImplementationClassUID: {
                Value: [DicomMetaDictionary.uid()], // TODO: could be git hash or other valid id
                vr: "UI"
            },
            ImplementationVersionName: {
                Value: ["dcmjs"],
                vr: "SH"
            }
        };

        dataset._meta = _meta;

        return dataset;
    }

    /**
     * Generate Cornerstone tool state from dataset
     * @param {object} dataset dataset
     * @param {object} hooks
     * @param {function} hooks.getToolClass Function to map dataset to a tool class
     * @returns
     */
    //static generateToolState(_dataset, _hooks = {}) {
    static generateToolState() {
        // Todo
        console.warn("RTSS.generateToolState not implemented");
    }
}

function initializeDataset(metadata, metadataProvider) {
    const rtSOPInstanceUID = DicomMetaDictionary.uid();

    // get the first annotation data
    const { referencedImageId: imageId, FrameOfReferenceUID } = metadata;

    const { studyInstanceUID } = metadataProvider.get(
        "generalSeriesModule",
        imageId
    );

    const patientModule = getPatientModule(imageId, metadataProvider);
    const rtSeriesModule = getRTSeriesModule(DicomMetaDictionary);

    return {
        StructureSetROISequence: [],
        ROIContourSequence: [],
        RTROIObservationsSequence: [],
        ReferencedSeriesSequence: [],
        ReferencedFrameOfReferenceSequence: [],
        ...patientModule,
        ...rtSeriesModule,
        StudyInstanceUID: studyInstanceUID,
        SOPClassUID: "1.2.840.10008.5.1.4.1.1.481.3", // RT Structure Set Storage
        SOPInstanceUID: rtSOPInstanceUID,
        Manufacturer: "dcmjs",
        Modality: "RTSTRUCT",
        FrameOfReferenceUID,
        PositionReferenceIndicator: "",
        StructureSetLabel: "",
        StructureSetName: "",
        ReferringPhysicianName: "",
        OperatorsName: "",
        StructureSetDate: DicomMetaDictionary.date(),
        StructureSetTime: DicomMetaDictionary.time()
    };
}