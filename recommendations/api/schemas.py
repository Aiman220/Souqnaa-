from typing import List, Optional
from pydantic import BaseModel

class ProductScore(BaseModel):
    productId: str
    score: float

class UserRecommendationRequest(BaseModel):
    userId: str
    limit: Optional[int] = 20

class UserRecommendationResponse(BaseModel):
    userId: str
    modelVersion: str
    recommendations: List[ProductScore]

class TrainingTriggerRequest(BaseModel):
    pipelineName: Optional[str] = "train_lightfm.py"

class TrainingTriggerResponse(BaseModel):
    success: bool
    message: str
