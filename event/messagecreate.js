const { handleGeminiRequest } = require('../utils/geminihandler');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const { createRoleplayEmbed } = require('../utils/embeds');
const config = require('../utils/config');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        if (message.author.bot) return;
        
        if (!message.mentions.has(message.client.user.id)) return;
        
        const content = message.content.replace(/<@!?(\d+)>/g, '').trim();
        
        if (!content) return;
        
        try {
            const user = await User.findOneAndUpdate(
                { userId: message.author.id },
                { userId: message.author.id },
                { upsert: true, new: true }
            );

            let effectiveDefaultCharacterName = user.defaultCharacterName || config.defaultCharacterName;
            const hasDefaultProfile = user.characterProfiles.some(
                profile => profile.name === effectiveDefaultCharacterName
            );

            // Migrate legacy/default names that no longer map to a valid profile.
            if (!hasDefaultProfile && effectiveDefaultCharacterName !== config.defaultCharacterName) {
                effectiveDefaultCharacterName = config.defaultCharacterName;
                user.defaultCharacterName = config.defaultCharacterName;
                await user.save();
            }
            
            let conversation = await Conversation.findOne({
                userId: message.author.id,
                isActive: true
            });
            
            if (!conversation) {
                conversation = new Conversation({
                    userId: message.author.id,
                    characterName: effectiveDefaultCharacterName,
                    messages: []
                });
            } else {
                const conversationProfileExists = user.characterProfiles.some(
                    profile => profile.name === conversation.characterName
                );

                if (!conversationProfileExists && conversation.characterName !== config.defaultCharacterName) {
                    conversation.characterName = effectiveDefaultCharacterName;
                }
            }
            
            conversation.messages.push({
                role: 'user',
                content: content
            });
            
            const characterProfile = user.characterProfiles.find(
                profile => profile.name === conversation.characterName
            ) || {
                name: config.defaultCharacterName,
                personality: config.fallbackPersonality,
                appearance: config.appearance.defaultAppearance
            };
            
            message.channel.sendTyping();
            
            const userPreferences = {
                preferredLanguage: user.preferredLanguage || 'Vietnamese',
                customBotPersonality: user.customBotPersonality || '',
                responseStyle: user.responseStyle || {
                    length: 'medium',
                    poeticLevel: 3,
                    detailLevel: 4,
                    metaphorUsage: false,
                    paragraphCount: 3
                }
            };
            
            const aiResponse = await handleGeminiRequest(conversation.messages, characterProfile, userPreferences);
            
            conversation.messages.push({
                role: 'assistant',
                content: aiResponse
            });
            
            // Giới hạn số tin nhắn trong database (giữ 40 tin nhắn gần nhất)
            if (conversation.messages.length > 40) {
                conversation.messages = conversation.messages.slice(-40);
            }
            
            await conversation.save();
            
            const embed = createRoleplayEmbed(
                conversation.characterName,
                aiResponse,
                characterProfile.appearance
            );
            
            await message.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error in messageCreate event:', error);
            await message.reply('Sorry, I encountered an error while processing your message.');
        }
    }
};