#include "RecognitionHandler.h"
#include <algorithm>
#include <limits>
#include <rnexecutorch/data_processing/ImageProcessing.h>
#include <rnexecutorch/models/ocr/Constants.h>
#include <rnexecutorch/models/ocr/utils/RecognitionHandlerUtils.h>

namespace rnexecutorch::models::ocr {
RecognitionHandler::RecognitionHandler(
    const std::string &recognizerSource, const std::string &symbols,
    std::shared_ptr<react::CallInvoker> callInvoker)
    : converter(symbols), recognizer(recognizerSource, callInvoker) {
  memorySizeLowerBound = recognizer.getMemoryLowerBound();
}

std::pair<std::vector<int32_t>, float>
RecognitionHandler::runModel(cv::Mat image) {

  // Note that the height of an  image is always equal to 64.
  int32_t desiredWidth = utils::getDesiredWidth(image, false);
  return recognizer.generate(image, desiredWidth);
}

void RecognitionHandler::processBBox(std::vector<types::OCRDetection> &boxList,
                                     types::DetectorBBox &box, cv::Mat &imgGray,
                                     types::PaddingInfo ratioAndPadding) {

  /*
    Resize the cropped image to have height = 64 (height accepted by
    Recognizer).
  */
  auto croppedImage =
      utils::cropImage(box, imgGray, constants::kRecognizerHeight);

  if (croppedImage.empty()) {
    return;
  }

  /*
    Cropped image is resized into the closest of on of three:
    128x64, 256x64, 512x64.
  */
  croppedImage =
      utils::normalizeForRecognizer(croppedImage, constants::kRecognizerHeight,
                                    constants::kAdjustContrast, false);

  auto [predictionIndices, confidenceScore] = this->runModel(croppedImage);
  if (confidenceScore < constants::kLowConfidenceThreshold) {
    cv::rotate(croppedImage, croppedImage, cv::ROTATE_180);
    auto [rotatedPredictionIndices, rotatedConfidenceScore] =
        runModel(croppedImage);
    if (rotatedConfidenceScore > confidenceScore) {
      confidenceScore = rotatedConfidenceScore;
      predictionIndices = rotatedPredictionIndices;
    }
  }
  /*
    Since the boxes were corresponding to the image resized to 1280x1280,
    we want to return the boxes shifted and rescaled to match the original
    image dimensions. Compute the axis-aligned bounding box (AABB) from the
    four rotated corners and store only the top-left and bottom-right points.
  */
  float minX = std::numeric_limits<float>::max();
  float minY = std::numeric_limits<float>::max();
  float maxX = std::numeric_limits<float>::lowest();
  float maxY = std::numeric_limits<float>::lowest();
  for (const auto &point : box.bbox) {
    float x = (point.x - ratioAndPadding.left) * ratioAndPadding.resizeRatio;
    float y = (point.y - ratioAndPadding.top) * ratioAndPadding.resizeRatio;
    minX = std::min(minX, x);
    minY = std::min(minY, y);
    maxX = std::max(maxX, x);
    maxY = std::max(maxY, y);
  }
  boxList.emplace_back(
      std::array<types::Point, 2>{types::Point{minX, minY},
                                  types::Point{maxX, maxY}},
      converter.decodeGreedy(predictionIndices, predictionIndices.size())[0],
      confidenceScore);
}

std::vector<types::OCRDetection>
RecognitionHandler::recognize(std::vector<types::DetectorBBox> bboxesList,
                              cv::Mat &imgGray, cv::Size desiredSize) {
  /*
   Recognition Handler accepts bboxesList corresponding to size
   1280x1280, which is desiredSize.
  */
  types::PaddingInfo ratioAndPadding =
      utils::calculateResizeRatioAndPaddings(imgGray.size(), desiredSize);
  imgGray = image_processing::resizePadded(imgGray, desiredSize);

  std::vector<types::OCRDetection> result = {};
  for (auto &box : bboxesList) {
    processBBox(result, box, imgGray, ratioAndPadding);
  }
  return result;
}

std::size_t RecognitionHandler::getMemoryLowerBound() const noexcept {
  return memorySizeLowerBound;
}

void RecognitionHandler::unload() noexcept { recognizer.unload(); }
} // namespace rnexecutorch::models::ocr
