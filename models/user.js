const mongoose = require('mongoose');

const characterProfileSchema = new mongoose.Schema({
    name: { type: String, required: true },
    personality: { type: String, required: true },
    appearance: { type: String, required: true }
});

const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    defaultCharacterName: { type: String, default: 'Michele' },
    characterProfiles: [characterProfileSchema],
    preferredLanguage: { type: String, enum: ['Vietnamese', 'English'], default: 'Vietnamese' },
    customBotPersonality: { type: String, default: '' },
    
    // Cài đặt phong cách phản hồi
    responseStyle: {
        length: { type: String, enum: ['short', 'medium', 'long', 'poetic'], default: 'medium' },
        poeticLevel: { type: Number, min: 1, max: 5, default: 3 }, // 1: trung tính, 5: biểu cảm cao
        detailLevel: { type: Number, min: 1, max: 5, default: 4 }, // 1: ngắn gọn, 5: rất chi tiết
        metaphorUsage: { type: Boolean, default: false }, // Có sử dụng ẩn dụ không
        paragraphCount: { type: Number, min: 1, max: 10, default: 3 } // Số đoạn văn mong muốn
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);