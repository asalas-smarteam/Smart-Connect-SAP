import mongoose from 'mongoose';

export class MongooseObjectIdValidator {
  isValid(value) {
    return mongoose.Types.ObjectId.isValid(value);
  }
}

export default MongooseObjectIdValidator;
